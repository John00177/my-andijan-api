import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuthzRule } from './authz.decorators';
import { ruleOf } from './decide';

// Enumerates every HTTP route the application exposes, straight from the
// real controller metadata, with the authorization rule each one carries.
// Used only by the route-authorization tests (Phase 15D, D-75) — it is how
// CI notices a route that declares no rule, or a rule that changed.

export interface RouteEntry {
  route: string; // "GET /admin/stats"
  controller: string;
  handler: string;
  rule: AuthzRule | undefined;
}

type ControllerClass = abstract new (...args: never[]) => unknown;

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') || name.endsWith('.controller.js') ? [path] : [];
  });
}

function joinPath(prefix: string, path: string): string {
  const parts = [prefix, path].flatMap((p) => p.split('/')).filter(Boolean);
  return '/' + parts.join('/');
}

export function controllerClasses(srcDir: string = join(__dirname, '..')): ControllerClass[] {
  const classes: ControllerClass[] = [];
  for (const file of controllerFiles(srcDir)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value === 'function' && Reflect.getMetadata(PATH_METADATA, value) !== undefined) {
        classes.push(value as ControllerClass);
      }
    }
  }
  return classes;
}

export function routeInventory(srcDir?: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const controller of controllerClasses(srcDir)) {
    const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name] as (...args: never[]) => unknown;
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (method === undefined || path === undefined) continue;
      entries.push({
        route: `${RequestMethod[method]} ${joinPath(prefix, path)}`,
        controller: controller.name,
        handler: name,
        rule: ruleOf(controller, handler),
      });
    }
  }
  return entries.sort((a, b) => a.route.localeCompare(b.route));
}

export function describeRule(rule: AuthzRule | undefined): string {
  if (!rule) return 'UNDECLARED';
  switch (rule.kind) {
    case 'public':
      return 'public';
    case 'authenticated':
      return 'authenticated';
    case 'capability':
      return `capability:${[...rule.capabilities].sort().join('+')}`;
    case 'governance':
      return `governance:${rule.action}`;
  }
}

export function routeSnapshot(srcDir?: string): Record<string, string> {
  return Object.fromEntries(routeInventory(srcDir).map((e) => [e.route, describeRule(e.rule)]));
}
