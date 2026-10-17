// onnxruntime-node ships without its .d.ts in this version; its API is onnxruntime-common's.
declare module 'onnxruntime-node' {
  export * from 'onnxruntime-common';
}
