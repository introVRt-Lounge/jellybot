declare module "node-webvtt" {
  type ParsedCue = {
    identifier?: string;
    start: number;
    end: number;
    text: string;
    styles?: string;
  };

  type ParsedVtt = {
    cues: ParsedCue[];
  };

  function parse(input: string): ParsedVtt;

  export default { parse };
}
