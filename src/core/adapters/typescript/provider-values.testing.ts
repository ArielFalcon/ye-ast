const source = (path: string, content: string) => ({ path, content });

export function providerValueFiles() {
  return [
    source("package.json", JSON.stringify({ dependencies: { "@angular/core": "1", "@angular/platform-browser": "1", "@angular/common": "1" } })),
    source("angular.json", JSON.stringify({ projects: { app: { root: "", architect: { build: { builder: "@angular/build:application", options: { browser: "src/main.ts" } } } } } })),
    source("src/token.ts", `import { InjectionToken } from '@angular/core'; export const BASE = new InjectionToken<string>('base');`),
    source("src/config.ts", `import { BASE } from './token'; import { environment } from './environment'; export const appConfig = { providers: [{ provide: BASE, useValue: environment.url }] };`),
    source("src/environment.ts", `export const environment = { url: 'https://example.test/api' };`),
    source("src/main.ts", `import { Component } from '@angular/core'; import { bootstrapApplication } from '@angular/platform-browser'; import { appConfig } from './config'; @Component({standalone: true, template: ''}) class App {} bootstrapApplication(App, appConfig);`),
    source("src/api.ts", `import { Injectable, inject, Inject } from '@angular/core'; import { HttpClient } from '@angular/common/http'; import { BASE } from './token'; @Injectable({ providedIn: 'root' }) class Api { private base = inject(BASE); constructor(private http: HttpClient) {} get(path: string) { return this.http.get(this.base + path) } } class Page { constructor(private api: Api) {} load() { return this.api.get('/items') } }`),
  ];
}
