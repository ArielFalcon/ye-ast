/**
 * The edges that count towards a symbol's fan-in and the hub bound, and the only ones that run what they reach: a call
 * or an instantiation says the symbol is used by that caller, where a reference or a hierarchy edge only says the two
 * are related. Bridges, importers and Angular relations count towards neither.
 */
export const CALL_EDGE_KINDS: readonly string[] = ["calls", "instantiates"];
