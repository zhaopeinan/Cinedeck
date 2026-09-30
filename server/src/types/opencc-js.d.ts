declare module 'opencc-js' {
  export function Converter(opts: { from: string; to: string }): (text: string) => string;
}
