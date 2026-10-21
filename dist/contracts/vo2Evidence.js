/**
 * VO2 protocol identities (legacy and current, each version explicit), protocol
 * stage and adaptive provenance, and VO2 evidence schemas V1/V2.
 */
/** Local evidence for the VO2 estimator. Not itself a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION_V1 = 1;
export const VO2_EVIDENCE_SCHEMA_VERSION_V2 = 2;
/** Writer aliases. Historical readers must use the explicit V1 constants above. */
export const VO2_EVIDENCE_SCHEMA_VERSION = VO2_EVIDENCE_SCHEMA_VERSION_V2;
/** Permanent historical identity for the v1 protocol; keep readable after newer protocols ship. */
export const LEGACY_VO2_PROTOCOL_ID = "bike-submax-70rpm";
export const LEGACY_VO2_PROTOCOL_VERSION_V1 = 1;
/** Backward-compatible name for the permanent historical protocol identity. */
export const LEGACY_VO2_PROTOCOL_VERSION = LEGACY_VO2_PROTOCOL_VERSION_V1;
export const VO2_PROTOCOL_VERSION_V2 = 2;
export const VO2_PROTOCOL_VERSION_V3 = 3;
/** Protocol identity shared by formal assessments. New athlete-started sessions write v3; v2 remains the reader for historical evidence. */
export const VO2_PROTOCOL_ID = LEGACY_VO2_PROTOCOL_ID;
/** v2 marker used by the v2 reader/validators. Do not point at v3: v2 validation depends on this staying 2. */
export const VO2_PROTOCOL_VERSION = VO2_PROTOCOL_VERSION_V2;
