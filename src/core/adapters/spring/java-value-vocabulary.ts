export const QUALIFIER = "org.springframework.beans.factory.annotation.Qualifier";
export const PRIMARY = "org.springframework.context.annotation.Primary";
export const BEAN = "org.springframework.context.annotation.Bean";
export const NAMED_COMPONENTS: ReadonlySet<string> = new Set(["org.springframework.stereotype.Component", "org.springframework.stereotype.Service", QUALIFIER]);
export const LOMBOK_VALUE = "lombok.Value";
export const LOMBOK_BUILDER = "lombok.Builder";
export const LOMBOK_GETTERS: ReadonlySet<string> = new Set(["lombok.Data", LOMBOK_VALUE, "lombok.Getter"]);
export const LOMBOK_CONSTRUCTORS: ReadonlySet<string> = new Set(["lombok.AllArgsConstructor", LOMBOK_VALUE]);
