import { isDataApn, normalizeApn } from "./nas.js";
export const emptyQos = (activeFamily = null) => ({
  sessions: {},
  selected: null,
  activeFamily,
  epsIdentities: {},
  familyConfirmed: false,
  registrationConfirmed: false,
  requests: {},
});
export const isDataSession = (s) =>
  !!s?.defaultBearer && !!s.apn && isDataApn(s.apn);
function eligible(state, id, s) {
  return (
    isDataSession(s) &&
    (!state.activeFamily || id.startsWith(state.activeFamily + ":"))
  );
}
function withSessions(state, sessions, preferred = state.selected) {
  return {
    ...state,
    sessions,
    selected:
      preferred &&
      sessions[preferred] &&
      eligible(state, preferred, sessions[preferred])
        ? preferred
        : (Object.entries(sessions).findLast(([id, s]) =>
            eligible(state, id, s),
          )?.[0] ?? null),
  };
}
export const dataSession = (state) =>
  state.selected &&
  state.sessions[state.selected] &&
  eligible(state, state.selected, state.sessions[state.selected])
    ? state.sessions[state.selected]
    : null;
export function registeredNetwork(state, type, confirmed = false, fromSession = false) {
  const key = String(type).trim().toUpperCase(),
    family =
      key === "SA"
        ? "NR"
        : ["LTE", "LTE_CA", "LTE_A", "ENDC", "LTE-NSA", "NSA"].includes(key)
          ? "LTE"
          : null;
  if (!family || fromSession && state.registrationConfirmed && family !== state.activeFamily || !confirmed && state.familyConfirmed) return state;
  if (family === state.activeFamily) return confirmed && (!state.familyConfirmed || !fromSession && !state.registrationConfirmed) ? {...state,familyConfirmed:true,registrationConfirmed:state.registrationConfirmed||!fromSession} : state;
  const retained = confirmed && state.activeFamily
    ? Object.fromEntries(
        Object.entries(state.sessions).filter(
          ([id]) => !id.startsWith(state.activeFamily + ":"),
        ),
      )
    : state.sessions;
  const requests = confirmed && state.activeFamily ? Object.fromEntries(Object.entries(state.requests).filter(([key])=>!key.startsWith(state.activeFamily+':'))) : state.requests;
  return withSessions({ ...state, activeFamily: family, familyConfirmed:confirmed, registrationConfirmed:confirmed&&!fromSession, requests }, retained);
}
const sameProcedureWindow=(now,then)=>Number.isFinite(now)&&Number.isFinite(then)&&now>=then&&now-then<=120000;
export function updateQos(state, n, now = Date.now()) {
  if(n.encrypted)return state;
  const name=(n.name??'').split(/\s*→\s*/).at(-1);
  if(name==='REGISTRATION_ACCEPT')state=registeredNetwork(state,'SA',true);
  if(['LTE Attach Accept','LTE TAU Accept'].includes(name))state=registeredNetwork(state,'LTE',true);
  const nr = n.type === "5GSM",
    id = nr ? n.pduSessionId : n.epsBearerId;
  if (id == null || id < (nr ? 1 : 5) || id > 15) return state;
  const key = `${nr ? "NR" : "LTE"}:${id}`,
    sessions = state.sessions;
  if (
    [
      "LTE Deactivate EPS Bearer",
      "LTE Deactivate EPS Bearer Accept",
      "PDU_SESSION_RELEASE_COMMAND",
      "PDU_SESSION_RELEASE_COMPLETE",
    ].includes(name)
  ) {
    const remaining = Object.fromEntries(
        Object.entries(sessions).filter(
          ([k, s]) => k !== key && s.linkedBearer !== key,
        ),
      ),
      removed = Object.keys(sessions).filter((k) => !(k in remaining)),
      identities = { ...state.epsIdentities };
    for (const k of [...removed, key])
      if (k.startsWith("LTE:")) delete identities[Number(k.split(":")[1])];
    for (const k of removed)
      if (sessions[k].mappedEpsBearerId != null)
        delete identities[sessions[k].mappedEpsBearerId];
    const requests={...state.requests};delete requests[key];
    return withSessions({ ...state, epsIdentities: identities, requests }, remaining);
  }
  if(name==='PDU_SESSION_ESTABLISHMENT_REQUEST')return {...state,requests:{...state.requests,[key]:{pti:n.pti,apn:n.dnn==null?null:normalizeApn(n.dnn),requestedAt:now}}};
  if(name==='PDU_SESSION_ESTABLISHMENT_REJECT'){
    const requests={...state.requests};if(requests[key]?.pti===n.pti)delete requests[key];
    return {...state,requests};
  }
  const apn = n.dnn == null ? null : normalizeApn(n.dnn),
    established = [
      "LTE Activate Default EPS Bearer",
      "LTE Attach Accept",
      "PDU_SESSION_ESTABLISHMENT_ACCEPT",
    ].includes(name);
  const pending=state.requests[key], prior=sessions[key];
  const request=established&&Number.isInteger(n.pti)&&pending?.pti===n.pti&&sameProcedureWindow(now,pending.requestedAt)?pending:null;
  const duplicate=established&&!pending&&Number.isInteger(n.pti)&&prior?.establishmentPti===n.pti&&sameProcedureWindow(now,prior.establishedAt);
  let old = established && !duplicate ? null : prior;
  if (
    n.mappedEpsBearers?.some(
      (m) => m.operation === 2 && m.id === old?.mappedEpsBearerId,
    )
  )
    old = { ...old, apn: null, qci: null, flows: {}, mappedEpsBearerId: null };
  if (
    !old &&
    n.dnn == null &&
    n.qci == null &&
    !n.qosFlows?.length &&
    n.ambr == null &&
    !n.mappedEpsBearers?.length
  )
    return state;
  const link =
      n.linkedEpsBearerId != null
        ? `LTE:${n.linkedEpsBearerId}`
        : (old?.linkedBearer ?? null),
    mappings = (n.mappedEpsBearers ?? []).filter((m) => m.operation !== 2),
    defaultMappings = mappings.filter(
      (m) => state.epsIdentities[m.id]?.defaultBearer,
    ),
    mapped =
      defaultMappings.length === 1
        ? defaultMappings[0]
        : mappings.length === 1
          ? mappings[0]
          : null,
    mappedId = mapped?.id ?? old?.mappedEpsBearerId ?? null,
    identity = state.epsIdentities[mappedId]?.defaultBearer
      ? state.epsIdentities[mappedId]
      : null,
    priorEps = !nr && !established ? state.epsIdentities[n.epsBearerId] : null,
    network =
      apn ??
      request?.apn ??
      old?.apn ??
      sessions[link]?.apn ??
      identity?.apn ??
      priorEps?.apn ??
      null,
    seed = old?.apn == null ? (identity?.flows ?? priorEps?.flows ?? {}) : {},
    flows = { ...seed, ...old?.flows };
  for (const f of n.qosFlows ?? []) {
    if (!nr && f.epsBearerId != null && f.epsBearerId !== n.epsBearerId)
      continue;
    if (f.operation === 2) delete flows[f.qfi];
    else
      flows[f.qfi] =
        f.operation === 3 && f.qi == null
          ? { ...f, qi: flows[f.qfi]?.qi ?? null }
          : { ...f };
  }
  const qi = [
      ...new Set(
        Object.values(flows)
          .map((f) => f.qi)
          .filter((v) => v != null),
      ),
    ].sort((a, b) => a - b),
    flowQi = qi.length ? qi.join(", ") : null,
    qci = nr
      ? (flowQi ??
        (mapped?.qci == null ? null : String(mapped.qci)) ??
        (old?.apn == null && n.qosFlows == null ? identity?.qci : null) ??
        (n.qosFlows == null ? old?.qci : null) ??
        null)
      : n.qci != null
        ? String(n.qci)
        : (old?.qci ?? priorEps?.qci ?? null);
  const session = {
      apn: network,
      qci,
      ambr: n.ambr ?? old?.ambr ?? null,
      source: n.name,
      defaultBearer:
        old?.defaultBearer ??
        priorEps?.defaultBearer ??
        !n.name.includes("Dedicated EPS Bearer"),
      linkedBearer: link,
      flows,
      mappedEpsBearerId: mappedId,
      qiLabel: nr && flowQi !== null ? "5QI" : "QCI",
      establishmentPti: established ? n.pti : old?.establishmentPti,
      establishedAt: established && !duplicate ? now : old?.establishedAt,
    },
    base = (established || name==='PDU_SESSION_MODIFICATION_COMMAND' || name==='LTE Modify EPS Bearer' && (state.activeFamily!=='NR'||!dataSession(state))) && isDataSession(session) ? registeredNetwork(state,nr?'SA':'LTE',true,true) : state,
    retained = established
      ? Object.fromEntries(
          Object.entries(base.sessions).filter(([, s]) => s.linkedBearer !== key),
        )
      : { ...base.sessions },
    identities = { ...state.epsIdentities };
  if (established && sessions[key]?.mappedEpsBearerId != null)
    delete identities[sessions[key].mappedEpsBearerId];
  for (const m of n.mappedEpsBearers ?? [])
    if (m.operation === 2) delete identities[m.id];
  if (!nr)
    identities[n.epsBearerId] = {
      apn: network,
      qci,
      flows: { ...session.flows },
      defaultBearer: session.defaultBearer,
    };
  else if (network !== null) {
    const refreshed =
      !mappings.length && mappedId !== null
        ? [{ id: mappedId, operation: 3 }]
        : mappings;
    for (const m of refreshed) {
      const prior = identities[m.id]?.apn === network ? identities[m.id] : null,
        mappedFlows = Object.fromEntries(
          Object.entries(session.flows).filter(
            ([, f]) => f.epsBearerId === m.id,
          ),
        );
      identities[m.id] = {
        apn: network,
        qci: m.qci == null ? (prior?.qci ?? null) : String(m.qci),
        flows: mappedFlows,
        defaultBearer: mappedId === m.id && session.defaultBearer,
      };
    }
  }
  retained[key] = session;
  const next = Object.fromEntries(
    Object.entries(retained).map(([k, s]) => {
      const eps =
        k.startsWith("NR:") &&
        s.apn == null &&
        identities[s.mappedEpsBearerId]?.defaultBearer
          ? identities[s.mappedEpsBearerId]
          : null;
      if (!eps?.apn) return [k, s];
      const resolvedFlows = { ...eps.flows, ...s.flows },
        qi = [
          ...new Set(
            Object.values(resolvedFlows)
              .map((f) => f.qi)
              .filter((v) => v != null),
          ),
        ].sort((a, b) => a - b);
      return [
        k,
        {
          ...s,
          apn: eps.apn,
          qci: qi.length ? qi.join(", ") : (s.qci ?? eps.qci),
          flows: resolvedFlows,
          qiLabel: qi.length ? "5QI" : s.qiLabel,
        },
      ];
    }),
  );
  const requests={...base.requests};if(established)delete requests[key];
  return withSessions(
    { ...base, epsIdentities: identities, requests },
    next,
    established && isDataSession(session) ? key : base.selected,
  );
}
