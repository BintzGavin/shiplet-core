import { describe, expect, it, vi } from "vitest";

import {
  MAX_EXTERNAL_METADATA_BYTES,
  inspectExternalUrlMetadata,
} from "../src/external-url-metadata";

describe("external URL metadata", () => {
  it("Given competing page metadata, when Shiplet inspects the page, then the social title wins and entities become a bounded DNS-safe suggestion", async () => {
    const result = await inspectExternalUrlMetadata({
      url: new URL("https://preview.example.com/releases/summer/"),
      isAllowedUrl: () => true,
      fetcher: async () =>
        new Response(
          `<!doctype html><head>
            <meta name="application-name" content="Fallback application">
            <meta name="twitter:title" content="Twitter title">
            <title>Document title</title>
            <meta content="Caf&eacute; NewRo &amp; Friends" property="og:title">
          </head>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });

    expect(result).toEqual({
      finalUrl: "https://preview.example.com/releases/summer/",
      name: "Café NewRo & Friends",
      source: "og:title",
      subdomain: "cafe-newro-friends",
    });
  });

  it("Given a safe redirect and a title-only document, when Shiplet follows it, then every hop is revalidated and the final URL is reported", async () => {
    const requests: Request[] = [];
    const allowedUrls: string[] = [];
    const result = await inspectExternalUrlMetadata({
      url: new URL("https://preview.example.com/start"),
      isAllowedUrl: (url) => {
        allowedUrls.push(url.toString());
        return url.hostname === "preview.example.com";
      },
      fetcher: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "/final/report" },
          });
        }
        return new Response("<head><title>Quarterly Review</title></head>", {
          headers: { "content-type": "text/html" },
        });
      },
    });

    expect(allowedUrls).toEqual([
      "https://preview.example.com/start",
      "https://preview.example.com/final/report",
    ]);
    expect(requests.map((request) => request.url)).toEqual(allowedUrls);
    expect(result).toMatchObject({
      finalUrl: "https://preview.example.com/final/report",
      name: "Quarterly Review",
      source: "title",
      subdomain: "quarterly-review",
    });
  });

  it("Given a redirect to a denied destination, when Shiplet inspects metadata, then it stops before making the unsafe request", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal" },
        }),
    );

    await expect(
      inspectExternalUrlMetadata({
        url: new URL("https://preview.example.com/start"),
        isAllowedUrl: (url) => url.hostname !== "127.0.0.1",
        fetcher,
      }),
    ).rejects.toThrow("redirect denied");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Given a document whose head exceeds the metadata budget, when Shiplet inspects it, then it cancels the stream and falls back to the hostname", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(MAX_EXTERNAL_METADATA_BYTES + 1).fill(32),
        );
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await inspectExternalUrlMetadata({
      url: new URL("https://newro-eats.vercel.app/"),
      isAllowedUrl: () => true,
      fetcher: async () =>
        new Response(body, { headers: { "content-type": "text/html" } }),
    });

    expect(cancelled).toBe(true);
    expect(result).toMatchObject({
      name: "Newro Eats",
      source: "url",
      subdomain: "newro-eats",
    });
  });
});
