export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

export const IMAGE_MARKER = /\[image:([^\[\]\r\n]+)\]/g

export const MEDIA_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{6}\.(png|jpg|jpeg|webp)$/

export function mediaName(file) {
  const name = String(file ?? "").split("/").pop() || ""
  return MEDIA_NAME.test(name) ? name : ""
}

export function mediaUrl(file) {
  const name = mediaName(file)
  return name ? `/media/${encodeURIComponent(name)}` : ""
}

export function splitImageMarkers(text) {
  const source = String(text ?? "")
  const images = []
  const rest = source.replace(IMAGE_MARKER, (_whole, raw) => {
    const target = String(raw || "").trim()
    if (target) images.push(target)
    return " "
  })
  if (images.length === 0) return { text: source, images: [] }
  const prose = rest
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => line)
    .join("\n")
  return { text: prose, images }
}

export function isImageType(type) {
  return IMAGE_TYPES.includes(String(type || ""))
}
