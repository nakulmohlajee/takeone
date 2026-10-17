/** Grab a still from a recorded take so cutaways can match lighting and color. */
export async function grabVideoFrame(
  videoUrl: string,
  atSeconds = 0.6
): Promise<{ dataUrl: string; base64: string; mimeType: string } | null> {
  if (!videoUrl) return null;
  const video = document.createElement('video');
  video.src = videoUrl;
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Could not load take'));
      setTimeout(() => resolve(), 2500);
    });
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    video.currentTime = Math.min(Math.max(0.15, atSeconds), dur * 0.4);
    await new Promise((r) => setTimeout(r, 280));
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, 640, 640);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    const base64 = dataUrl.split(',')[1] || '';
    return { dataUrl, base64, mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    video.src = '';
  }
}
