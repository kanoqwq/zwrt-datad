//! Publish one coherent, identified data session. Never combine an IMS QCI or
//! an old log's AMBR with a different DIAG session.
use serde_json::{Value, json};

fn data_apn(apn: &str) -> bool {
    if apn.is_empty()
        || apn.len() > 100
        || !apn
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return false;
    }
    let first = apn.split('.').next().unwrap_or_default();
    ![
        "ims",
        "sos",
        "emergency",
        "sos-emergency",
        "emergency-service",
    ]
    .iter()
    .any(|name| first.eq_ignore_ascii_case(name))
}

fn mbps(value: u64) -> String {
    // NAS rates are integer kbps or larger. Keep exact 3-digit Mbps values.
    format!("{}.{:03}", value / 1_000_000, value % 1_000_000 / 1000)
}

pub fn state(signaling: &Value, rat: &str, fallback: impl FnOnce() -> crate::qos::Values) -> Value {
    if signaling.get("available").and_then(Value::as_bool) != Some(true)
        || signaling.get("qos_version").and_then(Value::as_u64) != Some(1)
        || !matches!(
            signaling.get("qos_domain").and_then(Value::as_str),
            Some("5gs" | "eps")
        )
    {
        let fallback = fallback();
        let available =
            fallback.qci > 0 || !fallback.ambr_dl.is_empty() || !fallback.ambr_ul.is_empty();
        return json!({"qci":fallback.qci,"ambr_dl":fallback.ambr_dl,"ambr_ul":fallback.ambr_ul,
            "available":available,"source":if available {"oem_key_log"} else {"unavailable"},
            "reason":if available {""} else {"no_oem_qos_sample"}});
    }
    let domain = signaling["qos_domain"].as_str().unwrap_or_default();
    let unavailable = |reason: &str| {
        json!({"qci":0,"ambr_dl":"","ambr_ul":"","available":false,
        "source":"diag_nas","reason":reason})
    };
    let compatible = match rat.to_ascii_uppercase().as_str() {
        "SA" | "NR" | "NR5G" | "5G" => domain == "5gs",
        "LTE" | "LTE_CA" | "LTE_A" => domain == "eps",
        "NSA" | "ENDC" | "LTE-NSA" => true, // NSA radio hints cannot change the NAS domain.
        _ => false,
    };
    if !compatible {
        return unavailable("waiting_current_nas_domain");
    }
    let Some(rows) = signaling.get("qos_sessions").and_then(Value::as_array) else {
        return unavailable("waiting_data_session");
    };
    let mut candidates = rows.iter().take(32).filter(|row| {
        let id = row.get("id").and_then(Value::as_u64).unwrap_or(0);
        row.get("domain").and_then(Value::as_str) == Some(domain)
            && (if domain == "eps" { 5..=15 } else { 1..=15 }).contains(&id)
            && row.get("apn").and_then(Value::as_str).is_some_and(data_apn)
    });
    let Some(row) = candidates.next() else {
        return unavailable("waiting_data_session");
    };
    if candidates.next().is_some() {
        return unavailable("multiple_data_sessions");
    }
    let qci = row
        .get("qci")
        .and_then(Value::as_u64)
        .filter(|v| (1..=255).contains(v))
        .unwrap_or(0);
    let ambr = row
        .get("ambr_dl_bps")
        .and_then(Value::as_u64)
        .zip(row.get("ambr_ul_bps").and_then(Value::as_u64))
        .filter(|(dl, ul)| dl % 1000 == 0 && ul % 1000 == 0);
    if qci == 0 && ambr.is_none() {
        return unavailable("waiting_data_qos");
    }
    json!({"qci":qci,"ambr_dl":ambr.map(|v|mbps(v.0)).unwrap_or_default(),
        "ambr_ul":ambr.map(|v|mbps(v.1)).unwrap_or_default(),"available":true,
        "source":"diag_nas","reason":"","apn":row["apn"],"session_id":row["id"],
        "domain":domain,"sampled_at":row.get("sampled_at").and_then(Value::as_u64)})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn diag(rows: Value) -> Value {
        json!({"available":true,"qos_version":1,"qos_domain":"5gs","qos_sessions":rows})
    }
    fn data() -> Value {
        json!({"domain":"5gs","id":1,"qci":9,"apn":"internet","ambr_dl_bps":1_000_000_000u64,"ambr_ul_bps":200_000_000u64})
    }
    fn old() -> crate::qos::Values {
        crate::qos::Values {
            qci: 8,
            ambr_dl: "64.000".into(),
            ambr_ul: "32.000".into(),
        }
    }
    #[test]
    fn complete_session_uses_mbps_and_ims_never_overwrites_it() {
        let ims = json!({"domain":"5gs","id":2,"qci":5,"apn":"ims.mnc001.mcc460.gprs","ambr_dl_bps":100_000_000,"ambr_ul_bps":100_000_000});
        let value = state(&diag(json!([data(), ims])), "SA", old);
        assert_eq!(value["qci"], 9);
        assert_eq!(value["ambr_dl"], "1000.000");
        assert_eq!(value["ambr_ul"], "200.000");
        assert_eq!(value["source"], "diag_nas");
    }
    #[test]
    fn releases_unknown_apns_and_domain_changes_never_resurrect_old_log_rates() {
        for rows in [
            json!([]),
            json!([{ "domain":"5gs","id":1,"qci":9,"apn":"" }]),
            json!([{ "domain":"5gs","id":2,"qci":5,"apn":"ims" }]),
        ] {
            assert_eq!(state(&diag(rows), "SA", old)["available"], false);
        }
        assert_eq!(
            state(&diag(json!([data()])), "LTE", old)["available"],
            false
        );
        assert_eq!(
            state(&diag(json!([data()])), "ENDC", old)["available"],
            true
        );
    }
    #[test]
    fn partial_diag_data_cannot_be_completed_from_another_source() {
        let mut row = data();
        row.as_object_mut().unwrap().remove("ambr_ul_bps");
        let value = state(&diag(json!([row])), "SA", old);
        assert_eq!(value["qci"], 9);
        assert_eq!(value["ambr_dl"], "");
        assert_eq!(value["ambr_ul"], "");
        assert_eq!(
            state(&diag(json!([data(), data()])), "SA", old)["available"],
            false
        );
    }
    #[test]
    fn legacy_log_fallback_and_true_zero_rates_are_retained() {
        assert_eq!(state(&Value::Null, "SA", old)["ambr_dl"], "64.000");
        let mut row = data();
        row["ambr_dl_bps"] = json!(0);
        row["ambr_ul_bps"] = json!(0);
        assert_eq!(state(&diag(json!([row])), "SA", old)["ambr_dl"], "0.000");
    }

    #[test]
    fn live_nas_never_reads_fallback_logs_and_eps_keeps_the_same_contract() {
        let mut row = data();
        row["domain"] = json!("eps");
        row["id"] = json!(5);
        let mut source = diag(json!([row]));
        source["qos_domain"] = json!("eps");
        let value = state(&source, "LTE", || panic!("live NAS must not scan OEM logs"));
        assert_eq!(value["qci"], 9);
        assert_eq!(value["ambr_dl"], "1000.000");
        assert_eq!(value["domain"], "eps");
        assert!(!data_apn("IMS.mnc001.mcc460.gprs"));
    }
}
