import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";

export const REST_TEMPLATE_TYPES: ReadonlySet<string> = new Set(["org.springframework.web.client.RestTemplate", "org.springframework.web.client.RestOperations"]);
export const FLUENT_CLIENT_TYPES: ReadonlySet<string> = new Set(["org.springframework.web.client.RestClient", "org.springframework.web.reactive.function.client.WebClient"]);
export const FEIGN_CLIENT = "org.springframework.cloud.openfeign.FeignClient";
export const CONFIGURATION_PROPERTIES = "org.springframework.boot.context.properties.ConfigurationProperties";
export const VALUE = "org.springframework.beans.factory.annotation.Value";
const SERVICE = "org.springframework.web.service.annotation.";
export const HTTP_EXCHANGE = `${SERVICE}HttpExchange`;
export const REQUEST_METHOD_TYPES: readonly string[] = ["HttpMethod", "RequestMethod"];

/** The request methods of `RestTemplate` that fix the HTTP method by their name; `exchange` and `execute` take it as an argument. */
export const TEMPLATE_VERBS: ReadonlyMap<string, HttpMethod> = new Map([
  ["getForObject", "GET"],
  ["getForEntity", "GET"],
  ["headForHeaders", "HEAD"],
  ["postForObject", "POST"],
  ["postForEntity", "POST"],
  ["postForLocation", "POST"],
  ["put", "PUT"],
  ["patchForObject", "PATCH"],
  ["delete", "DELETE"],
  ["optionsForAllow", "OPTIONS"],
]);
export const TEMPLATE_EXPLICIT: ReadonlySet<string> = new Set(["exchange", "execute"]);

export const FLUENT_VERBS: ReadonlyMap<string, HttpMethod> = new Map([
  ["get", "GET"],
  ["head", "HEAD"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
  ["options", "OPTIONS"],
]);

export const EXCHANGE_VERBS: ReadonlyMap<string, HttpMethod> = new Map(
  [...FLUENT_VERBS].map(([name, method]) => [`${SERVICE}${name[0]?.toUpperCase()}${name.slice(1)}Exchange`, method]),
);

export const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]);

/** The names a type that makes HTTP requests carries; a call through one whose source is unknown is a cut naming it. */
export const HTTP_CLIENT_NAME = /(RestClient|WebClient|HttpClient|RestTemplate|RestOperations|ApiClient)$/;

/** Methods that pass a URI builder's text through unchanged. */
export const TRANSPARENT_URI_METHODS: ReadonlySet<string> = new Set(["build", "buildAndExpand", "toUri", "toUriString", "encode", "expand", "queryParam", "toString", "normalize", "toASCIIString"]);
export const URI_FACTORIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["URI", new Set(["create"])],
  ["UriComponentsBuilder", new Set(["fromHttpUrl", "fromUriString"])],
]);
