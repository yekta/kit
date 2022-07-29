import { Adapter } from '@sveltejs/kit';

type TOptions= {
  define?: { [key: string]: string };
}

type Options = {
	edge?: boolean;
	external?: string[];
	split?: boolean;
	esbuildOptions?: TOptions;
};

export default function plugin(options?: Options): Adapter;
