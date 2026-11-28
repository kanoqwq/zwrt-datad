import meta from "./rrc-labels.json" with { type: "json" };
import { decodeEps, plmn } from "./nas.js";
import { bytesFromHex } from "./core.js";
export const at = (node, ...keys) => keys.reduce((v, k) => v?.[k], node);
export function walk(node, visit, path = [], depth = 0) {
  if (depth > 180 || !node || typeof node !== "object") return;
  visit(node, path);
  for (const [k, v] of Object.entries(node))
    walk(v, visit, [...path, k], depth + 1);
}
export function broadcastPlmns(tree) {
  const access = at(
    tree,
    "message",
    "c1",
    "systemInformationBlockType1",
    "cellAccessRelatedInfo",
  );
  if (!access) return null;
  const nr = access["plmn-IdentityInfoList"],
    lists = Array.isArray(nr)
      ? nr.map((g) => g["plmn-IdentityList"])
      : [access["plmn-IdentityList"]];
  if (lists.some((l) => !Array.isArray(l) || !l.length)) return null;
  const out = [];
  for (const list of lists) {
    let mcc = null;
    for (const row of list) {
      const p = nr ? row : row["plmn-Identity"];
      if (!p) return null;
      function digits(v, min, max) {
        return Array.isArray(v) &&
          v.length >= min &&
          v.length <= max &&
          v.every((n) => Number.isInteger(n) && n >= 0 && n <= 9)
          ? v.join("")
          : null;
      }
      if ("mcc" in p) {
        mcc = digits(p.mcc, 3, 3);
        if (!mcc) return null;
      }
      const mnc = digits(p.mnc, 2, 3);
      if (!mcc || !mnc) return null;
      out.push(plmn(mcc, mnc));
    }
  }
  return out.length >= 1 && out.length <= 64 ? out : null;
}
export function selectedPlmn(tree) {
  const c1 = at(tree, "message", "c1"),
    nr = at(c1, "rrcSetupComplete", "criticalExtensions", "rrcSetupComplete"),
    lte = at(
      c1,
      "rrcConnectionSetupComplete",
      "criticalExtensions",
      "c1",
      "rrcConnectionSetupComplete-r8",
    ),
    value = (nr ?? lte)?.["selectedPLMN-Identity"];
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : null;
}
export function nrCellIdentity(tree) {
  const value = at(
    tree,
    "message",
    "c1",
    "systemInformationBlockType1",
    "cellAccessRelatedInfo",
    "plmn-IdentityInfoList",
  )?.[0]?.cellIdentity;
  return typeof value === "string" && /^[\da-fA-F]{9}0$/.test(value)
    ? String(BigInt("0x" + value) >> 4n)
    : null;
}
export function nrBroadcastBand(tree) {
  const list = at(
    tree,
    "message",
    "c1",
    "systemInformationBlockType1",
    "servingCellConfigCommon",
    "downlinkConfigCommon",
    "frequencyInfoDL",
    "frequencyBandList",
  );
  if (!Array.isArray(list)) return null;
  const bands = [
    ...new Set(list.map((b) => b.freqBandIndicatorNR).filter(Number.isInteger)),
  ];
  return bands.length === 1 ? "n" + bands[0] : null;
}
export function rrcEvidence(tree, radio) {
  let security = null,
    embedded = null;
  walk(tree, (n) => {
    if (n.cipheringAlgorithm != null)
      security = {
        cipher: n.cipheringAlgorithm,
        integrity: n.integrityProtAlgorithm ?? null,
      };
    if (embedded === null && typeof n["dedicatedNAS-Message"] === "string")
      embedded = n["dedicatedNAS-Message"];
  });
  let eps = null;
  if (radio === "LTE" && embedded && /^(?:[\da-fA-F]{2})+$/.test(embedded))
    eps = decodeEps(bytesFromHex(embedded));
  return {
    broadcastPlmns: broadcastPlmns(tree),
    selectedPlmnIndex: selectedPlmn(tree),
    security: eps?.security ?? security,
    nas: eps?.nas ?? null,
  };
}
export {fingerprint as vendorEvidence, verdict as vendorVerdict} from "./sigweb/vendor.js";
export function findP0(bytes) {
  const bits = bytes.length * 8,
    read = (p, n) => {
      let v = 0;
      for (let i = 0; i < n; i++)
        v = (v << 1) | ((bytes[(p + i) >>> 3] >>> (7 - ((p + i) & 7))) & 1);
      return v;
    };
  for (const [pusch, pucch] of [
    [-76, -100],
    [-74, -100],
    [-100, -110],
  ])
    for (let i = 0; i < bits - 72; i++)
      if (read(i, 8) === pusch + 202)
        for (let j = i + 16; j <= i + 48 && j < bits - 8; j++)
          if (read(j - 1, 1) === 1 && read(j, 8) === pucch + 202)
            return [pusch, pucch];
  return null;
}
export function lteNeighbors(tree) {
  const cells = new Map();
  walk(tree, (n) => {
    for (const entry of n.measResultListEUTRA ?? []) {
      const pci = entry?.physCellId,
        r = entry?.measResult,
        p = r?.rsrpResult,
        q = r?.rsrqResult;
      if (Number.isInteger(pci) && pci >= 0 && pci <= 503)
        cells.set(pci, {
          pci,
          rsrp: Number.isInteger(p) && p >= 1 && p <= 96 ? p - 141 : null,
          rsrq: Number.isInteger(q) && q >= 1 && q <= 34 ? q * 0.5 - 20 : null,
          arfcn: null,
          beams: [],
        });
    }
  });
  return [...cells.values()];
}
export const emptyMeasurements = () => ({ objects: {}, identities: {} });
export function updateMeasurements(old, tree) {
  const message = at(tree, "message", "c1");
  if (!message) return old;
  if (
    Object.keys(message).some((k) =>
      [
        "rrcConnectionRelease",
        "rrcConnectionSetup",
        "rrcConnectionReestablishment",
        "rrcConnectionReestablishmentRequest",
        "rrcConnectionRequest",
      ].includes(k),
    )
  )
    return emptyMeasurements();
  const reconfig = at(
    message,
    "rrcConnectionReconfiguration",
    "criticalExtensions",
    "c1",
    "rrcConnectionReconfiguration-r8",
  );
  if (!reconfig) return old;
  if ("mobilityControlInfo" in reconfig) return emptyMeasurements();
  const config = reconfig.measConfig;
  if (!config) return old;
  const objects = { ...old.objects },
    identities = { ...old.identities };
  for (const id of config.measObjectToRemoveList ?? []) {
    delete objects[id];
    for (const [k, i] of Object.entries(identities))
      if (i.objectId === id) delete identities[k];
  }
  for (const id of config.reportConfigToRemoveList ?? [])
    for (const [k, i] of Object.entries(identities))
      if (i.reportId === id) delete identities[k];
  for (const id of config.measIdToRemoveList ?? []) delete identities[id];
  for (const e of config.measObjectToAddModList ?? []) {
    const id = e.measObjectId,
      f = e.measObject?.measObjectEUTRA?.carrierFreq;
    if (!Number.isInteger(id) || id < 1 || id > 32) continue;
    delete objects[id];
    if (Number.isInteger(f) && f >= 0 && f <= 65534) objects[id] = f;
  }
  for (const e of config.measIdToAddModList ?? []) {
    const id = e.measId,
      objectId = e.measObjectId,
      reportId = e.reportConfigId;
    if (!Number.isInteger(id) || id < 1 || id > 32) continue;
    delete identities[id];
    if (
      [objectId, reportId].every(
        (n) => Number.isInteger(n) && n >= 1 && n <= 32,
      )
    )
      identities[id] = { objectId, reportId };
  }
  return { objects, identities };
}
export function measurementNeighbors(context, tree) {
  const report = at(
    tree,
    "message",
    "c1",
    "measurementReport",
    "criticalExtensions",
    "c1",
    "measurementReport-r8",
    "measResults",
  );
  if (!report) return [];
  const id =
      "measId-v1250" in report ? null : context.identities[report.measId],
    frequency = id ? (context.objects[id.objectId] ?? null) : null;
  return lteNeighbors(report).map((c) => ({ ...c, arfcn: frequency }));
}
export function updateLinkConfig(old, tree) {
  let result = old;
  const c1 = at(tree, "message", "c1");
  if (
    c1 &&
    Object.keys(c1).some((k) =>
      ["rrcSetup", "rrcRelease", "rrcReestablishment"].includes(k),
    )
  )
    result = { ports: {}, cellGroupId: null };
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.CellGroupConfig) {
      const g = node.CellGroupConfig,
        id = g.cellGroupId;
      if (id != null && id !== result.cellGroupId)
        result = { ports: {}, cellGroupId: id };
      const sp = g.spCellConfig;
      if (sp) {
        if ("reconfigurationWithSync" in sp)
          result = { ports: {}, cellGroupId: id };
        const csi = sp.spCellConfigDedicated?.["csi-MeasConfig"];
        if (csi && "release" in csi) result = { ports: {}, cellGroupId: id };
        else if (csi?.setup) {
          const next = { ...result.ports };
          for (const id of csi.setup["nzp-CSI-RS-ResourceToReleaseList"] ?? [])
            delete next[id];
          for (const row of csi.setup["nzp-CSI-RS-ResourceToAddModList"] ??
            []) {
            const id = row["nzp-CSI-RS-ResourceId"];
            if (id == null) continue;
            const count = Number(
              String(row.resourceMapping?.nrofPorts ?? "").replace(/^p/, ""),
            );
            if ([1, 2, 4, 8, 12, 16, 24, 32].includes(count)) next[id] = count;
            else delete next[id];
          }
          result = { ports: next, cellGroupId: id ?? result.cellGroupId };
        }
      }
    }
    for (const [key, v] of Object.entries(node))
      if (
        ![
          "sCellToAddModList",
          "measConfig",
          "ue-CapabilityRAT-ContainerList",
        ].includes(key)
      )
        visit(v);
  }
  visit(tree);
  return result;
}
export function engineeringFormat(key, value, radio) {
  if (value === null) return key === "release" ? "未配置" : "已配置";
  if (typeof value === "number" && Number.isInteger(value)) {
    if (["q-RxLevMin", "q-RxLevMinOffset"].includes(key))
      return `${value * 2} ${key === "q-RxLevMin" ? "dBm" : "dB"}（编码 ${value}）`;
    if (["q-QualMin", "q-QualMin-r9", "q-QualMinOffset"].includes(key))
      return value + " dB";
    if (["p-Max", "preambleReceivedTargetPower"].includes(key))
      return value + " dBm";
    if (key === "ss-PBCH-BlockPower") return value + " dBm/RE";
    if (key === "deltaPreambleMsg3" && radio === "LTE")
      return `${value * 2} dB（编码 ${value}）`;
    if (["t-ReselectionEUTRA", "t-ReselectionNR"].includes(key))
      return value + " s";
    if (
      [
        "carrierBandwidth",
        "offsetToCarrier",
        "msg1-FrequencyStart",
        "prach-FreqOffset",
      ].includes(key)
    )
      return value + " RB";
    return String(value);
  }
  const raw = String(value),
    simple = {
      true: "是",
      false: "否",
      infinity: "无限",
      allowed: "允许",
      notAllowed: "不允许",
      notBarred: "未禁止",
      barred: "禁止",
      enabled: "启用",
      disabled: "禁用",
    };
  if (simple[raw]) return simple[raw];
  if (key === "alpha")
    return (
      {
        al0: "0",
        al04: "0.4",
        al05: "0.5",
        al06: "0.6",
        al07: "0.7",
        al08: "0.8",
        al09: "0.9",
        al1: "1",
      }[raw] ?? raw
    );
  const m = raw.match(/^(ms|kHz|dBm|dB|rf|sf|sl)(-?\d+(?:p\d+)?)$/);
  if (m)
    return (
      m[2].replace("p", ".") +
      " " +
      ({ rf: "无线帧", sf: "子帧", sl: "时隙" }[m[1]] ?? m[1])
    );
  if (key === "si-WindowLength" && radio === "NR" && /^s\d+$/.test(raw))
    return raw.slice(1) + " 时隙";
  return raw;
}
export function updateEngineering(previous, radio, tree) {
  if (!["LTE", "NR"].includes(radio)) return previous;
  const message = at(tree, "message", "c1");
  if (!message) return previous;
  const sibs = {};
  if (message.systemInformationBlockType1)
    sibs.SIB1 = message.systemInformationBlockType1;
  const info = at(
    message,
    "systemInformation",
    "criticalExtensions",
    radio === "LTE" ? "systemInformation-r8" : "systemInformation",
  );
  for (const entry of info?.["sib-TypeAndInfo"] ?? [])
    for (const [key, v] of Object.entries(entry))
      if (
        ["sib2", "sib3", "sib4", "sib5", "sib6", "sib7"].includes(key) &&
        !(radio === "NR" && ["sib6", "sib7"].includes(key))
      )
        sibs[key.toUpperCase()] = v;
  const out = { ...previous },
    excluded = new Set(meta.excluded),
    title = (key) => meta.titles[key] ?? meta.labels[key] ?? key;
  for (const [sib, value] of Object.entries(sibs)) {
    const source = `${radio} ${sib}`,
      sections = [];
    function section(path, name, element) {
      const rows = [];
      function visit(node, location, names = []) {
        if (node !== null && typeof node === "object") {
          if (Array.isArray(node))
            node.forEach((v, i) =>
              visit(v, `${location}[${i}]`, [...names, `[${i + 1}]`]),
            );
          else
            for (const [key, v] of Object.entries(node))
              if (!excluded.has(key))
                visit(v, `${location}.${key}`, [...names, key]);
        } else {
          const key = names.at(-1) ?? path.split(".").at(-1);
          if (excluded.has(key)) return;
          const label = meta.labels[key] ?? meta.titles[key] ?? key,
            context = names
              .slice(0, -1)
              .filter((k) => !["setup", "nonCriticalExtension"].includes(k))
              .map(title)
              .join(" · ");
          rows.push({
            path: location,
            label: context ? `${context} · ${label}` : label,
            value: engineeringFormat(key, node, radio),
            raw: node,
          });
        }
      }
      visit(element, path);
      if (rows.length)
        sections.push({ id: `${source}:${path}`, title: name, source, rows });
    }
    function split(node, prefix) {
      for (const [key, v] of Object.entries(node ?? {}))
        if (!excluded.has(key)) section(`${prefix}.${key}`, title(key), v);
    }
    for (const [key, v] of Object.entries(value)) {
      if (excluded.has(key)) continue;
      if (key === "radioResourceConfigCommon") split(v, `${sib}.${key}`);
      else if (key === "servingCellConfigCommon") {
        for (const [k, child] of Object.entries(v)) {
          const path = `${sib}.${key}.${k}`;
          if (
            [
              "downlinkConfigCommon",
              "uplinkConfigCommon",
              "supplementaryUplink",
            ].includes(k)
          ) {
            for (const [direction, part] of Object.entries(child)) {
              if (
                ["initialDownlinkBWP", "initialUplinkBWP"].includes(direction)
              )
                for (const [bwpKey, config] of Object.entries(part))
                  section(
                    `${path}.${direction}.${bwpKey}`,
                    `${title(direction)} · ${title(bwpKey)}`,
                    config,
                  );
              else section(`${path}.${direction}`, title(direction), part);
            }
          } else if (!excluded.has(k)) section(path, title(k), child);
        }
      } else section(`${sib}.${key}`, title(key), v);
    }
    out[source] = sections;
  }
  return out;
}
export function highSpeedRail(radio, engineering) {
  if (radio !== "NR") return null;
  const rows = (engineering["NR SIB1"] ?? [])
      .flatMap((s) => s.rows)
      .filter((r) => r.path.startsWith("SIB1.")),
    row =
      rows.find(
        (r) =>
          r.path.split(".").at(-1) === "highSpeedMeasFlag-r16" &&
          String(r.raw) === "true",
      ) ??
      rows.find(
        (r) =>
          r.path.split(".").at(-1) === "restrictedSetConfig" &&
          [
            "restrictedSet",
            "restrictedSetTypeA",
            "restrictedSetTypeB",
          ].includes(r.raw),
      );
  return row
    ? {
        path: row.path,
        value: String(row.raw),
        detail: `NR ${row.path} = ${row.raw}`,
      }
    : null;
}
