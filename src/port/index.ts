import { register } from './core.js';
import { HttpAdapter } from './http.js';
import { ShellAdapter } from './shell.js';
import { TimeAdapter } from './time.js';

export * from './core.js';
export * from './shell.js';
export * from './http.js';
export * from './time.js';

register(ShellAdapter);
register(HttpAdapter);
register(TimeAdapter);
