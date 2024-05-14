export interface ZerofishOpts {
  root?: string;
  net?: { name: string; url: string };
  search?: FishOpts;
}

export interface FishOpts {
  depth?: number;
  pvs?: number;
  ms?: number;
}

export type Score = { moves: string[]; score: number; depth: number };

export interface Zerofish {
  setNet: (name: string, weights: Uint8Array) => void;
  netName?: string;
  setSearch: (fishSearch: FishOpts) => void;
  goZero: (fen: string) => Promise<string>;
  goFish: (fen: string, opts?: FishOpts) => Promise<Score /* pv */[] /* depth */[]>;
  quit: () => void;
  stop: () => void;
  reset: () => void;
  zero: (cmd: string) => void;
  fish: (cmd: string) => void;
}

export default async function initModule({ root, net, search }: ZerofishOpts = {}): Promise<Zerofish> {
  const fetchWeights = net ? fetch(net.url) : Promise.resolve(undefined);
  const dontBundleMe = root ?? '.';
  const module = await import(`${dontBundleMe}/zerofishEngine.js`);
  const wasm = await module.default();
  const weightsRsp = await fetchWeights;
  if (weightsRsp) wasm.setZeroWeights(new Uint8Array(await weightsRsp.arrayBuffer()));

  return new (class implements Zerofish {
    netName?: string = net?.name;
    search?: FishOpts = search;
    zero = wasm.zero;
    fish = wasm.fish;

    setNet(name: string, weights: Uint8Array) {
      wasm.setZeroWeights(weights);
      this.netName = name;
    }
    setSearch(searchOpts: FishOpts) {
      this.search = searchOpts;
    }
    goZero(fen: string) {
      return new Promise<string>((resolve, reject) => {
        if (!this.netName) return reject('unitialized');
        wasm['listenZero'] = (msg: string) => {
          if (!msg) return;
          const tokens = msg.split(' ');
          if (tokens[0] === 'bestmove') resolve(tokens[1]);
        };
        wasm.zero(`position fen ${fen}`);
        wasm.zero(`go nodes 1`); // TODO - evilgyal and tinygyal need an actual search
      });
    }
    quit() {
      this.stop();
      wasm.quit();
    }
    stop() {
      if (this.netName) wasm.zero('stop');
      wasm.fish('stop');
    }
    reset() {
      this.stop();
      wasm.fish('ucinewgame');
      if (this.netName) wasm.zero('ucinewgame');
    }
    goFish(fen: string, opts = this.search) {
      return new Promise<Score /* pv */[] /* depth */[]>(resolve => {
        const numPvs = opts?.pvs ?? 1;
        const pvs: Score[][] = Array.from({ length: opts?.pvs ?? 1 }, () => []);
        wasm['listenFish'] = (line: string) => {
          const tokens = line.split(' ');
          const shiftParse = (field: string) => {
            while (tokens.length > 1) if (tokens.shift() === field) return parseInt(tokens.shift()!);
          };
          if (tokens[0] === 'bestmove') resolve(pvs.slice());
          else if (tokens.shift() === 'info') {
            if (tokens.length < 7) return;
            const depth = shiftParse('depth')!;
            const byDepth: Score[] = pvs[shiftParse('multipv')! - 1];
            const score = shiftParse('cp')!;
            const moveIndex = tokens.indexOf('pv') + 1;

            if (depth > byDepth.length && moveIndex > 0)
              byDepth.push({
                moves: tokens.slice(moveIndex),
                score,
                depth,
              });
          } else console.warn('unknown line', line);
        };
        wasm.fish(`setoption name multipv value ${numPvs}`);
        wasm.fish(`position fen ${fen}`);
        if (opts?.ms) wasm.fish(`go movetime ${opts.ms}`);
        else wasm.fish(`go depth ${opts?.depth ?? 12}`);
      });
    }
  })();

  function ucinum(tokens: string[], field: string) {
    return parseInt(ucival(tokens, field));
  }

  function ucival(tokens: string[], field: string) {
    if (!tokens.length) return '';
    return tokens[tokens.indexOf(field) + 1];
  }
}
