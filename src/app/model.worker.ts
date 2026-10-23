/// <reference lib="webworker" />
import { serve } from '../net/workercall';
import { ModelMirror, computeModel, type ModelDelta, type ModelOutput } from './model';

const mirror = new ModelMirror();

serve<ModelDelta, ModelOutput>(self, (delta) => computeModel(mirror.apply(delta)));
