/**
 * Headless renderer for Open Design daemon.
 *
 * Provides drop-in replacements for the three desktop-runtime renderers
 * (desktopArtifactExporter, desktopSlideRenderer, desktopPdfExporter)
 * using Playwright's headless Chromium instead of Electron.
 *
 * The daemon uses these when the desktop runtime is not connected
 * (headless mode), so `od export --format pdf|image|pptx` works on
 * servers without a GUI.
 *
 * Architecture: each renderer spawns (or reuses) a headless Chromium browser,
 * loads the HTML via a data: URL (self-contained, no network needed), and
 * uses page.pdf() / page.screenshot() to produce the output file.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  DesktopExportArtifactInput,
  DesktopExportArtifactResult,
  DesktopExportPdfInput,
  DesktopExportPdfResult,
  DesktopRenderSlidesInput,
  DesktopRenderSlidesResult,
} from "@open-design/sidecar-proto";

// Function types matching the daemon's server.ts definitions
export type DesktopArtifactExporter = (input: DesktopExportArtifactInput) => Promise<DesktopExportArtifactResult>;
export type DesktopSlideRenderer = (input: DesktopRenderSlidesInput) => Promise<DesktopRenderSlidesResult>;
export type DesktopPdfExporter = (input: DesktopExportPdfInput) => Promise<DesktopExportPdfResult>;

// ── Public API ──────────────────────────────────────────────────────────

export interface HeadlessRenderer {
  artifactExporter: DesktopArtifactExporter;
  slideRenderer: DesktopSlideRenderer;
  pdfExporter: DesktopPdfExporter;
  close: () => Promise<void>;
}

export async function createHeadlessRenderer(): Promise<HeadlessRenderer> {
  // Lazy import so the daemon doesn't crash if Playwright is not installed
  // (e.g. desktop-mode users who don't need headless rendering).
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  async function makePage(width?: number, height?: number) {
    const page = await browser.newPage({
      viewport: { width: width ?? 1920, height: height ?? 1080 },
    });
    return page;
  }

  /** Load HTML into a page with a <base> tag so relative asset URLs resolve
   *  against the daemon's raw-file endpoint, not the data: URL. */
  async function loadHtml(
    page: import("playwright").Page,
    html: string,
    baseHref?: string,
  ): Promise<void> {
    let finalHtml = html;
    if (baseHref) {
      // Inject <base> tag as the desktop renderer does, so relative paths
      // (images, fonts, CSS) resolve against the daemon's raw endpoint.
      const escaped = baseHref.replace(/"/g, "&quot;");
      finalHtml = html.replace(
        /<head([^>]*)>/i,
        `<head$1><base href="${escaped}">`,
      );
    }
    await page.setContent(finalHtml, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
  }

  // ── artifactExporter: PDF or single image ──────────────────────────────

  const artifactExporter: DesktopArtifactExporter = async (
    input: DesktopExportArtifactInput,
  ): Promise<DesktopExportArtifactResult> => {
    const page = await makePage(input.width, input.height);
    try {
      await loadHtml(page, input.html, input.baseHref);

      if (input.format === "pdf") {
        const outDir = await mkTempDir();
        const outPath = join(outDir, `${safeName(input.title)}.pdf`);
        await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
          path: outPath,
          ...(input.width && input.height
            ? { width: `${input.width}px`, height: `${input.height}px` }
            : {}),
        });
        return { ok: true, path: outPath, mime: "application/pdf" };
      }

      // image
      const isJpeg = input.imageFormat === "jpeg";
      const outDir = await mkTempDir();
      const outPath = join(outDir, `export.${isJpeg ? "jpg" : "png"}`);
      await page.screenshot({
        path: outPath,
        type: isJpeg ? "jpeg" : "png",
        fullPage: true,
      });
      return {
        ok: true,
        path: outPath,
        mime: isJpeg ? "image/jpeg" : "image/png",
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      await page.close().catch(() => {});
    }
  };

  // ── slideRenderer: deck (one image per slide) or full-page ─────────────

  const slideRenderer: DesktopSlideRenderer = async (
    input: DesktopRenderSlidesInput,
  ): Promise<DesktopRenderSlidesResult> => {
    const page = await makePage(
      input.width ?? 1920,
      input.height ?? 1080,
    );
    try {
      await loadHtml(page, input.html, input.baseHref);

      // Detect deck vs page mode — use the same selector as the desktop renderer
      // so slides revealed via [data-screen-label], .deck-slide, or .ppt-slide
      // are counted, and presenter clones / thumbnails are excluded.
      const slideCount = await page.evaluate(() => {
        return Array.prototype.slice
          .call(document.querySelectorAll('.slide, [data-screen-label], .deck-slide, .ppt-slide'))
          .filter((el) => !(el as HTMLElement).closest('.mini-slide, .overview, .notes-overlay, .thumb'))
          .length;
      });

      const isDeck = input.deck ?? slideCount > 0;
      const mode: "deck" | "page" = isDeck ? "deck" : "page";

      if (mode === "page") {
        // Full-page capture
        const isJpeg = input.pageImageFormat === "jpeg";
        if (input.paginate) {
          // Split into viewport-height images (for PDF multi-page)
          const viewportHeight = input.height ?? 1080;
          const dims = await page.evaluate(() => ({
            w: document.documentElement.scrollWidth || document.body.scrollWidth || window.innerWidth,
            h: document.documentElement.scrollHeight || document.body.scrollHeight || window.innerHeight,
          }));
          const fullWidth = Math.max(dims.w, 1);
          const fullHeight = Math.max(dims.h, 1);
          const pageCount = Math.max(1, Math.ceil(fullHeight / viewportHeight));
          const slideFiles: string[] = [];

          if (!input.outputDir) {
            return {
              ok: false,
              error: "paginate requires outputDir",
              errorCode: "RENDER_FAILED",
            };
          }

          for (let i = 0; i < pageCount; i++) {
            const clipHeight = Math.min(viewportHeight, fullHeight - i * viewportHeight);
            if (clipHeight <= 0) break;
            const outPath = join(input.outputDir, `page-${i}.${isJpeg ? "jpg" : "png"}`);
            // Scroll to the clip position so the content is rendered before capture.
            await page.evaluate((y: number) => window.scrollTo(0, y), i * viewportHeight);
            // Use fullPage screenshot then crop — clip fails on some pages
            // where the document layout doesn't match the clip coordinates.
            const buf = await page.screenshot({
              type: isJpeg ? "jpeg" : "png",
              fullPage: true,
            });
            // Crop the viewport slice from the full-page screenshot using sharp
            // (available in the daemon's dependency tree) — avoids Playwright
            // clip coordinate issues with absolutely-positioned content.
            const sharpMod = await import("sharp");
            const sharpFn = (sharpMod as any).default ?? sharpMod;
            const cropped = await sharpFn(buf)
              .extract({
                left: 0,
                top: i * viewportHeight,
                width: Math.round(fullWidth),
                height: Math.round(clipHeight),
              })
              .toFormat(isJpeg ? "jpeg" : "png")
              .toBuffer();
            await mkdir(input.outputDir, { recursive: true });
            await fsWriteFile(outPath, cropped);
            slideFiles.push(outPath);
          }
          return {
            ok: true,
            mode: "page",
            slideFiles,
            width: fullWidth,
            height: fullHeight,
          };
        }

        // Single full-page image
        if (input.outputDir) {
          const outPath = join(input.outputDir, `page.${isJpeg ? "jpg" : "png"}`);
          await page.screenshot({
            path: outPath,
            type: isJpeg ? "jpeg" : "png",
            fullPage: true,
          });
          return { ok: true, mode: "page", slideFiles: [outPath] };
        }

        // No outputDir — return base64
        const buf = await page.screenshot({
          type: isJpeg ? "jpeg" : "png",
          fullPage: true,
        });
        return {
          ok: true,
          mode: "page",
          slides: [`data:image/${isJpeg ? "jpeg" : "png"};base64,${buf.toString("base64")}`],
        };
      }

      // Deck mode: one image per slide
      if (slideCount === 0) {
        return {
          ok: false,
          error: "No .slide sections found",
          errorCode: "NO_SLIDES",
        };
      }

      // Determine which slides to render
      let indices: number[];
      if (typeof input.index === "number") {
        if (input.index < 0 || input.index >= slideCount) {
          return {
            ok: false,
            error: `Slide index ${input.index} out of range (0..${slideCount - 1})`,
            errorCode: "SLIDE_INDEX_OUT_OF_RANGE",
          };
        }
        indices = [input.index];
      } else {
        indices = Array.from({ length: slideCount }, (_, i) => i);
      }

      const slideFiles: string[] = [];
      const slides: string[] = [];

      for (const idx of indices) {
        // Reveal slide — mirror the desktop renderer's showSlide() logic:
        // toggle active classes + attributes + inline !important overrides
        // so the slide is visible regardless of how the deck hides inactive ones.
        // Use the same expanded selector as the desktop renderer.
        await page.evaluate((i: number) => {
          const slides = Array.prototype.slice
            .call(document.querySelectorAll('.slide, [data-screen-label], .deck-slide, .ppt-slide'))
            .filter((el) => !(el as HTMLElement).closest('.mini-slide, .overview, .notes-overlay, .thumb'));
          const activeClasses = ["active", "visible", "is-active", "current"];
          const activeAttributes = ["data-od-deck-active"];
          slides.forEach((node, n) => {
            const el = node as HTMLElement;
            const on = n === i;
            el.style.setProperty("transition", "none", "important");
            el.style.setProperty("animation", "none", "important");
            el.style.setProperty("opacity", on ? "1" : "0", "important");
            el.style.setProperty("visibility", on ? "visible" : "hidden", "important");
            el.style.setProperty("display", on ? "flex" : "none", "important");
            el.style.setProperty("pointer-events", on ? "auto" : "none", "important");
            el.style.setProperty("z-index", on ? "999" : "0", "important");
            activeClasses.forEach((c) => el.classList.toggle(c, on));
            activeAttributes.forEach((a) => el.toggleAttribute(a, on));
          });
        }, idx);

        if (input.outputDir) {
          const outPath = join(input.outputDir, `slide-${idx}.png`);
          await page.screenshot({
            path: outPath,
            type: "png",
          });
          slideFiles.push(outPath);
        } else {
          const buf = await page.screenshot({ type: "png" });
          slides.push(`data:image/png;base64,${buf.toString("base64")}`);
        }
      }

      // Stitch if requested (image export of a deck)
      if (input.stitch && input.outputDir && slideFiles.length > 1) {
        // For stitching, reveal all slides stacked vertically and take a fullPage shot.
        // Override position to relative and clear inset/stretch so slides stack
        // top-to-bottom instead of overlapping at the same position.
        await page.evaluate(() => {
          const slides = Array.prototype.slice
            .call(document.querySelectorAll('.slide, [data-screen-label], .deck-slide, .ppt-slide'))
            .filter((el) => !(el as HTMLElement).closest('.mini-slide, .overview, .notes-overlay, .thumb'));
          const activeClasses = ["active", "visible", "is-active", "current"];
          const activeAttributes = ["data-od-deck-active"];
          slides.forEach((node) => {
            const el = node as HTMLElement;
            el.style.setProperty("transition", "none", "important");
            el.style.setProperty("animation", "none", "important");
            el.style.setProperty("opacity", "1", "important");
            el.style.setProperty("visibility", "visible", "important");
            el.style.setProperty("display", "flex", "important");
            el.style.setProperty("position", "relative", "important");
            el.style.setProperty("inset", "auto", "important");
            el.style.setProperty("width", "100%", "important");
            el.style.setProperty("height", "auto", "important");
            el.style.setProperty("min-height", "100vh", "important");
            el.style.setProperty("z-index", "999", "important");
            activeClasses.forEach((c) => el.classList.add(c));
            activeAttributes.forEach((a) => el.setAttribute(a, ""));
          });
          // Ensure the deck container and body allow vertical growth
          const deck = document.querySelector('.deck');
          if (deck) (deck as HTMLElement).style.setProperty("height", "auto", "important");
          document.body.style.setProperty("overflow", "visible", "important");
          document.documentElement.style.setProperty("overflow", "visible", "important");
        });
        const outPath = join(input.outputDir, "stitched.png");
        await page.screenshot({ path: outPath, type: "png", fullPage: true });
        return {
          ok: true,
          mode: "deck",
          slideFiles: [outPath],
          width: input.width ?? 1920,
          height: input.height ?? 1080,
        };
      }

      return {
        ok: true,
        mode: "deck",
        ...(slideFiles.length > 0 ? { slideFiles } : {}),
        ...(slides.length > 0 ? { slides } : {}),
        width: input.width ?? 1920,
        height: input.height ?? 1080,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || String(err),
        errorCode: "RENDER_FAILED",
      };
    } finally {
      await page.close().catch(() => {});
    }
  };

  // ── pdfExporter: standalone PDF route ─────────────────────────────────

  const pdfExporter: DesktopPdfExporter = async (
    input: DesktopExportPdfInput,
  ): Promise<DesktopExportPdfResult> => {
    const page = await makePage();
    try {
      await loadHtml(page, input.html, input.baseHref);
      const outDir = await mkTempDir();
      const outPath = join(outDir, `${safeName(input.defaultFilename)}.pdf`);
      await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
        path: outPath,
      });
      return { ok: true, path: outPath };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      await page.close().catch(() => {});
    }
  };

  return {
    artifactExporter,
    slideRenderer,
    pdfExporter,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

// ── Utilities ────────────────────────────────────────────────────────────

function safeName(name: string): string {
  return (name || "export").replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 100);
}

async function mkTempDir(): Promise<string> {
  const dir = join(tmpdir(), `od-render-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
