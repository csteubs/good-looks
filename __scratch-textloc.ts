import { JSDOM } from "jsdom";
import { DOM_HELPERS, UNIQUENESS_HELPERS } from "./main/recorder/capture-script.js";

const dom = new JSDOM(
  `<!doctype html><html><head><title>Checkout | Acme</title></head>
   <body><h1>Checkout</h1><button>Pay now</button></body></html>`,
  { url: "https://shop.test/checkout", pretendToBeVisual: true, runScripts: "outside-only" },
);
const out = dom.window.eval(`(function(){
  ${DOM_HELPERS}
  ${UNIQUENESS_HELPERS}
  var all = Array.prototype.slice.call(document.querySelectorAll("*"));
  var raw = all.filter(function(el){ return pwHas(el.textContent, "Checkout"); });
  return {
    tags: all.map(function(e){return e.tagName;}),
    rawHits: raw.map(function(e){return e.tagName;}),
    matched: matchesFor({k:"text", v:"Checkout"}).map(function(e){return e.tagName;}),
  };
})()`) as { tags: string[]; rawHits: string[]; matched: string[] };
console.log(out);
