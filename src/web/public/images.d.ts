export const IMAGE_TYPES: string[]
export const IMAGE_MAX_BYTES: number
export const IMAGE_MARKER: RegExp
export const MEDIA_NAME: RegExp
export function mediaName(file: unknown): string
export function mediaUrl(file: unknown): string
export function splitImageMarkers(text: unknown): { text: string; images: string[] }
export function isImageType(type: unknown): boolean
