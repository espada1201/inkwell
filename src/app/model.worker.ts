/// <reference lib="webworker" />
import { ModelMirror, computeModel, type ModelDelta, type ModelOutput } from './model';

export interface ModelRequest {
  id: number;
  delta: ModelDelta;
}
export interface ModelReply {
  id: number;
  output: ModelOutput;
}

const mirror = new ModelMirror();

self.onmessage = (e: MessageEvent<ModelRequest>) => {
  const { id, delta } = e.data;
  postMessage({ id, output: computeModel(mirror.apply(delta)) } satisfies ModelReply);
};
