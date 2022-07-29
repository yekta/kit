import { Adapter } from '@sveltejs/kit';
import './ambient.js';

export default function plugin(opts?: { split?: boolean; edge?: boolean, esbuildOptions?: TOptions }): Adapter;

type TOptions= {
  define?: { [key: string]: string };
}