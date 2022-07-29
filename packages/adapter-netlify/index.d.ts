import { Adapter } from '@sveltejs/kit';
import './ambient.js';

export default function plugin(opts?: { split?: boolean; edge?: boolean, options?: TOptions }): Adapter;

type TOptions= {
  define?: { [key: string]: string };
}