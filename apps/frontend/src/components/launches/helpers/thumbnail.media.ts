const privateVideoPath =
  /^\/api\/media\/private-local\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32,64}\.mp4$/;

function getPrivateVideoPath(mediaPath: string, frontEndUrl: string) {
  try {
    const media = new URL(mediaPath);
    const frontend = new URL(frontEndUrl);
    if (
      (media.protocol === 'http:' || media.protocol === 'https:') &&
      media.origin === frontend.origin &&
      !media.username &&
      !media.password &&
      !media.search &&
      !media.hash &&
      privateVideoPath.test(media.pathname)
    ) {
      return media.pathname;
    }
  } catch {
    return null;
  }
  return null;
}

export function getThumbnailVideoSource(
  mediaPath: string,
  backendUrl: string,
  frontEndUrl: string
) {
  return (
    getPrivateVideoPath(mediaPath, frontEndUrl) ??
    `${backendUrl}/public/stream?url=${encodeURIComponent(mediaPath)}`
  );
}

export function createThumbnailUploadForm(
  frame: Blob,
  mediaPath: string,
  frontEndUrl: string
) {
  const form = new FormData();
  form.append('file', frame, 'media.jpg');
  if (!getPrivateVideoPath(mediaPath, frontEndUrl)) {
    form.append('preventSave', 'true');
  }
  return form;
}
