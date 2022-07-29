import { Adapter } from '@sveltejs/kit';
import './ambient.js';

export default function plugin(options: TOptions): Adapter;

type TOptions= {
  esbuildOptions: {
    define?: { [key: string]: string };
  }
}
