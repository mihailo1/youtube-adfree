import { resolve } from "node:path";
import { defineConfig } from "wxt";

const ffmpegAssets = [
  {
    src: "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm",
    dest: "ffmpeg/ffmpeg-core.wasm"
  }
];

const FIREFOX_GECKO_ID = "youtube-adfree@local";
const { CSP_REPORT_URI = "" } = process.env;
const EXTENSION_PAGES_CSP = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'${CSP_REPORT_URI ? `; report-uri ${CSP_REPORT_URI}` : ""}`;
const sharedPermissions: Browser.runtime.ManifestPermission[] = [
  "alarms",
  "downloads",
  "unlimitedStorage",
  "notifications",
  "declarativeNetRequestWithHostAccess",
  "storage",
  "tabs",
  "webRequest"
];

export default defineConfig({
  srcDir: "src",
  publicDir: "src/public",
  modules: ["@wxt-dev/module-svelte"],
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "YouTube Ad-Free",
    description: "In-page ad-free YouTube player with quality, captions, and optional downloads",
    permissions: browser === "firefox" ? sharedPermissions : [...sharedPermissions, "offscreen"],
    host_permissions: [
      "https://*.youtube.com/*",
      "https://*.googlevideo.com/*",
      "https://i.ytimg.com/*"
    ],
    content_security_policy: {
      extension_pages: EXTENSION_PAGES_CSP
    },
    declarative_net_request: {
      rule_resources: [{
        id: "strip-youtube-frame-headers",
        enabled: true,
        path: "rules/strip-youtube-frame-headers.json"
      }]
    },
    web_accessible_resources: [
      {
        resources: ["offscreen.html", "ad-free-player.html"],
        matches: ["https://www.youtube.com/*", "https://youtube.com/*", "<all_urls>"]
      }
    ],
    ...browser === "firefox"
      ? {
        browser_specific_settings: {
          gecko: {
            id: FIREFOX_GECKO_ID,
            strict_min_version: "147.0",
            data_collection_permissions: {
              required: ["none"],
              optional: ["technicalAndInteraction"]
            }
          }
        }
      }
      : {
        minimum_chrome_version: "125.0"
      }
  }),
  zip: {
    artifactTemplate: "youtube-adfree-{{version}}-{{browser}}.zip",
    excludeSources: [
      "user-profiles/**",
      ".output/**",
      ".chrome-for-testing/**",
      ".wxt/**",
      ".dev-certs/**",
      ".fallow/**",
      "scripts/**"
    ]
  },
  hooks: {
    "prepare:publicPaths"(_, paths) {
      paths.push(...ffmpegAssets.map(asset => asset.dest));
    },
    "build:publicAssets"(_, assets) {
      for (const { src, dest } of ffmpegAssets) {
        assets.push({
          absoluteSrc: resolve(src),
          relativeDest: dest
        });
      }
    }
  }
});
