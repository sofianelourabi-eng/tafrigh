// Moteur de transcription Whisper (s'exécute en arrière-plan, sur l'appareil)
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;
env.useBrowserCache = true; // les modèles téléchargés restent sur l'appareil

let asr = null;
let key = '';
const queue = [];
let running = false;

async function hasF16() {
  try {
    const a = await navigator.gpu.requestAdapter();
    return !!a && a.features.has('shader-f16');
  } catch (e) { return false; }
}

async function load(model, device) {
  const k = model + '|' + device;
  if (asr && key === k) return;
  if (asr) { try { await asr.dispose(); } catch (e) {} asr = null; key = ''; }
  let dtype;
  if (device === 'webgpu') {
    const f16 = await hasF16();
    dtype = {
      encoder_model: f16 ? 'fp16' : (model.includes('large') ? 'q4' : 'fp32'),
      decoder_model_merged: 'q4'
    };
  } else {
    dtype = 'q8';
  }
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: p => postMessage({ type: 'progress', data: p })
  });
  key = k;
}

function msg(err) { return String((err && err.message) || err); }

async function handle(m) {
  if (m.cmd === 'load') {
    try {
      await load(m.model, m.device);
      postMessage({ type: 'loaded', id: m.id, device: m.device });
    } catch (err) {
      postMessage({ type: 'loadError', id: m.id, message: msg(err) });
    }
  } else if (m.cmd === 'transcribe') {
    try {
      if (!asr) throw new Error('Modèle non chargé');
      const out = await asr(m.audio, { language: 'arabic', task: 'transcribe' });
      postMessage({ type: 'result', id: m.id, text: ((out && out.text) || '').trim() });
    } catch (err) {
      postMessage({ type: 'error', id: m.id, message: msg(err) });
    }
  }
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) await handle(queue.shift());
  running = false;
}

onmessage = e => { queue.push(e.data); pump(); };
