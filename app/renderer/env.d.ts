import type { XaBridge } from '../shared/ipc.ts';
declare global { interface Window { xa: XaBridge } }
