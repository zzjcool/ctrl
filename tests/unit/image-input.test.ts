import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  IMAGE_MAX_BYTES,
  isImageType,
  mediaName,
  mediaUrl,
  splitImageMarkers,
} from "../../src/web/public/images.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const publicDir = path.join(repoRoot, "src/web/public")

function read(name: string): string {
  return readFileSync(path.join(publicDir, name), "utf8")
}

test("a user message is split into its prose and its image paths", () => {
  assert.deepEqual(splitImageMarkers("just words"), { text: "just words", images: [] })
  assert.deepEqual(splitImageMarkers("[image:/a.png]"), { text: "", images: ["/a.png"] })
  assert.deepEqual(splitImageMarkers("看这个 [image:/a.png] 是什么"), {
    text: "看这个 是什么",
    images: ["/a.png"],
  })
  assert.deepEqual(splitImageMarkers("[image:/a.png] [image:/b.webp]"), {
    text: "",
    images: ["/a.png", "/b.webp"],
  })
  assert.deepEqual(splitImageMarkers("one\ntwo [image:/a.png]\nthree"), {
    text: "one\ntwo\nthree",
    images: ["/a.png"],
  })
  assert.deepEqual(splitImageMarkers("[image:]"), { text: "[image:]", images: [] }, "an empty marker is not a marker")
  assert.deepEqual(splitImageMarkers("keep  my   spacing"), { text: "keep  my   spacing", images: [] })
  assert.deepEqual(splitImageMarkers(null), { text: "", images: [] })
})

test("only a stored media name becomes a thumbnail url", () => {
  assert.equal(mediaName("/root/.ctrl/agents/main/media/20240304T050607Z-abcdef.png"), "20240304T050607Z-abcdef.png")
  assert.equal(mediaUrl("/root/.ctrl/agents/main/media/20240304T050607Z-abcdef.jpg"), "/media/20240304T050607Z-abcdef.jpg")
  assert.equal(mediaName("/tmp/shot.png"), "")
  assert.equal(mediaUrl("/tmp/shot.png"), "")
  assert.equal(mediaName("../../agent.json"), "")
  assert.equal(mediaUrl("../../etc/passwd.png"), "")
  assert.equal(mediaName("20240304T050607Z-abcdef.gif"), "")
})

test("the page accepts the same three types and the same 5 MB ceiling as the server", () => {
  assert.equal(isImageType("image/png"), true)
  assert.equal(isImageType("image/jpeg"), true)
  assert.equal(isImageType("image/webp"), true)
  assert.equal(isImageType("image/gif"), false)
  assert.equal(isImageType("text/plain"), false)
  assert.equal(isImageType(undefined), false)
  assert.equal(IMAGE_MAX_BYTES, 5 * 1024 * 1024)
})

test("the composer wires paste, drop and a file button to the upload endpoint", () => {
  const html = read("index.html")
  assert.match(html, /id="attach"/)
  assert.match(html, /id="file"/)
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/)
  assert.match(html, /id="file"[^>]*multiple/s)

  const app = read("app.js")
  assert.match(app, /"\/api\/agent\/images"/)
  assert.match(app, /addEventListener\("paste"/)
  assert.match(app, /addEventListener\("drop"/)
  assert.match(app, /addEventListener\("dragover"/)
  assert.match(app, /clipboardData/)
  assert.match(app, /els\.file\.click\(\)/)
  assert.match(app, /\[image:\$\{saved\.path\}\]/)
  assert.match(app, /user-images/)
})

test("thumbnails are capped at 240px and open the original in a new window", () => {
  const styles = read("styles.css")
  const rule = /\.user-image img\s*\{([^}]*)\}/.exec(styles)
  assert.ok(rule, "styles.css needs a .user-image img rule")
  assert.match(String(rule[1]), /max-height:\s*240px/)

  const app = read("app.js")
  assert.match(app, /link\.target = "_blank"/)
  assert.match(app, /link\.rel = "noopener"/)
})
