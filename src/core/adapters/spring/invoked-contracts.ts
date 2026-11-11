/** How a framework obtains an implementation. */
export type Registration = "none" | "scanned-bean" | { readonly annotation: string };

export type InvokedContract =
  | { readonly by: "supertype"; readonly type: string; readonly member: { readonly name: string; readonly arity: number }; readonly registration: Registration }
  | { readonly by: "annotation"; readonly type: string; readonly registration: Registration };

export const INVOKED_CONTRACTS: readonly InvokedContract[] = [
  { by: "supertype", type: "org.springframework.security.core.userdetails.UserDetailsService", member: { name: "loadUserByUsername", arity: 1 }, registration: "scanned-bean" },
  { by: "supertype", type: "jakarta.validation.ConstraintValidator", member: { name: "isValid", arity: 2 }, registration: "none" },
  { by: "supertype", type: "javax.validation.ConstraintValidator", member: { name: "isValid", arity: 2 }, registration: "none" },
];
