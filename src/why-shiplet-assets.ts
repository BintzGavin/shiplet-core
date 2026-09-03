import { WHY_SHIPLET_ASSETS } from "./generated-why-shiplet-assets";
import { ASSET_CACHE_CONTROL } from "./seo";

type WhyShipletAssetKey = keyof typeof WHY_SHIPLET_ASSETS;

const assetCache: Partial<Record<WhyShipletAssetKey, Uint8Array>> = {};

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function whyShipletAssetResponse(key: WhyShipletAssetKey) {
  if (!assetCache[key]) {
    assetCache[key] = decodeBase64(WHY_SHIPLET_ASSETS[key]);
  }
  const bytes = assetCache[key]!;
  return new Response(bytes.slice(), {
    headers: {
      "cache-control": ASSET_CACHE_CONTROL,
      "content-length": String(bytes.byteLength),
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
    },
  });
}
