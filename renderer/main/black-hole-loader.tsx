import * as React from "react";
import handInkLight from "./assets/hand-ink.png";
import handInkDark from "./assets/hand-ink-dark.png";

const LOOP_SECONDS = 3;
const ACCELERATION = 1.2;
const DIRECTION: 1 | -1 = 1;
const SWIRL = 0.8;
const DEPTH = 420;
const STEEPNESS = 3.1;
const HOLE_SHADOW = 0.45;
const RING_COUNT = 18;
const SPOKE_COUNT = 18;

const CX = 844;
const CY = 1302;
const RMIN = 42;
const RMAX = 1055;
const SQ = 0.55;

const NS = "http://www.w3.org/2000/svg";

interface Variant {
  strokeColor: string;
  handSrc: string;
  handInvert: boolean;
  handClip: { left: string; top: string; width: string; height: string };
  ix: number;
  iy: number;
  iw: number;
  ih: number;
}

const VARIANTS: Record<"light" | "dark", Variant> = {
  light: {
    strokeColor: "#141210",
    handSrc: handInkLight,
    handInvert: false,
    handClip: { left: "16.939%", top: "1.543%", width: "48.409%", height: "90.414%" },
    ix: 463,
    iy: 211,
    iw: 563,
    ih: 1113,
  },
  dark: {
    strokeColor: "#ebedef",
    handSrc: handInkDark,
    handInvert: true,
    handClip: { left: "16.681%", top: "0.975%", width: "48.839%", height: "91.145%" },
    ix: 460,
    iy: 204,
    iw: 568,
    ih: 1122,
  },
};

function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** Ported from a hand-drawn OkeeDokee export — a procedural SVG funnel animation with no external runtime deps. */
export function BlackHoleLoader({ size = 220, dark = false }: { size?: number; dark?: boolean }) {
  const variant = VARIANTS[dark ? "dark" : "light"];
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const fieldRef = React.useRef<SVGGElement | null>(null);
  const frontRef = React.useRef<SVGGElement | null>(null);
  const shadowRef = React.useRef<SVGEllipseElement | null>(null);
  const maskRef = React.useRef<SVGPathElement | null>(null);
  const cutRef = React.useRef<SVGPathElement | null>(null);
  const handClipRef = React.useRef<HTMLDivElement | null>(null);
  const handRef = React.useRef<HTMLImageElement | null>(null);

  React.useEffect(() => {
    const dur = Math.max(0.6, LOOP_SECONDS);
    const nr = RING_COUNT;
    const ns = SPOKE_COUNT;

    const g = fieldRef.current;
    const fg = frontRef.current;
    const rings: SVGPathElement[] = [];
    const spokes: SVGPathElement[] = [];
    const fRings: SVGPathElement[] = [];
    const fSpokes: SVGPathElement[] = [];

    if (g) {
      while (g.firstChild) g.removeChild(g.firstChild);
      for (let j = 0; j < ns; j++) {
        const el = document.createElementNS(NS, "path");
        el.setAttribute("stroke-width", "8");
        el.setAttribute("opacity", "0.92");
        g.appendChild(el);
        spokes.push(el as SVGPathElement);
      }
      for (let k = 0; k < nr; k++) {
        const el = document.createElementNS(NS, "path");
        g.appendChild(el);
        rings.push(el as SVGPathElement);
      }
    }
    if (fg) {
      while (fg.firstChild) fg.removeChild(fg.firstChild);
      for (let j = 0; j < ns; j++) {
        const el = document.createElementNS(NS, "path");
        el.setAttribute("stroke-width", "8");
        fg.appendChild(el);
        fSpokes.push(el as SVGPathElement);
      }
      for (let k = 0; k < nr; k++) {
        const el = document.createElementNS(NS, "path");
        fg.appendChild(el);
        fRings.push(el as SVGPathElement);
      }
    }

    const CYD = CY - DEPTH;
    const dropAt = (r: number) =>
      DEPTH * Math.pow(Math.max(0, (RMAX - r) / (RMAX - RMIN)), STEEPNESS);
    let RH = RMIN + 6;
    if (STEEPNESS > 1.05 && DEPTH > 1) {
      const tt = Math.pow((SQ * (RMAX - RMIN)) / (DEPTH * STEEPNESS), 1 / (STEEPNESS - 1));
      if (tt < 1) RH = Math.max(70, RMAX - tt * (RMAX - RMIN));
    }
    const cyRH = CYD + dropAt(RH);
    const lipY = (x: number) => cyRH + SQ * Math.sqrt(Math.max(0, RH * RH - (x - CX) * (x - CX)));

    let t = 0;
    let last = performance.now();
    let raf = 0;

    function draw() {
      const ph = (((t / dur) % 1) + 1) % 1;

      for (let k = 0; k < nr; k++) {
        const el = rings[k];
        if (!el) continue;
        const e = (((k + ph * DIRECTION) % nr) + nr) % nr;
        const u = e / nr;
        const r = RMIN + (RMAX - RMIN) * Math.pow(1 - u, ACCELERATION);
        const lr = Math.log(r);
        const cy = CYD + dropAt(r);
        const inHole = r < RH;
        let d = "";
        let fd = "";
        let pin = false;
        let pback = false;
        let anyCut = false;
        const M = 108;
        for (let i = 0; i <= M; i++) {
          const th = (i / M) * Math.PI * 2;
          const wob = 1 + 0.019 * Math.sin(3 * th + lr * 2.1) + 0.011 * Math.sin(5 * th - lr * 1.6);
          const rr = r * wob;
          const a = th + SWIRL * 0.35 * Math.log(RMAX / r);
          const px = CX + rr * Math.cos(a);
          const py = cy + rr * SQ * Math.sin(a);
          const pt = px.toFixed(1) + " " + py.toFixed(1);
          const keep = inHole ? py < lipY(px) - 2 : !(Math.sin(a) > 0.08 && r < RH + 45);
          if (keep) {
            d += (pback ? "L" : "M") + pt;
            pback = true;
          } else {
            pback = false;
            anyCut = true;
          }
          if (!inHole && Math.sin(a) > 0.08) {
            fd += (pin ? "L" : "M") + pt;
            pin = true;
          } else pin = false;
        }
        if (!inHole && !anyCut) d += "Z";
        el.setAttribute("d", d || "M0 0");
        const sw = (4.5 + 7.5 * Math.min(1, r / 520)).toFixed(2);
        const op = smooth(u / 0.08);
        el.setAttribute("stroke-width", sw);
        el.setAttribute("opacity", op.toFixed(3));
        const fe = fRings[k];
        if (fe) {
          const fop = op * smooth((RH + 110 - r) / 110) * smooth((r - RH) / 45);
          if (fd && fop > 0.005) {
            fe.setAttribute("d", fd);
            fe.setAttribute("stroke-width", sw);
            fe.setAttribute("opacity", fop.toFixed(3));
            fe.removeAttribute("display");
          } else fe.setAttribute("display", "none");
        }
      }

      const rot = -DIRECTION * ph * ((Math.PI * 2) / ns);
      for (let j = 0; j < ns; j++) {
        const el = spokes[j];
        if (!el) continue;
        const base = j * ((Math.PI * 2) / ns) + rot;
        let d = "";
        let fd = "";
        let pin = false;
        let pback = false;
        const M2 = 54;
        for (let i = 0; i <= M2; i++) {
          const r = 46 * Math.pow(RMAX / 46, i / M2);
          const a = base + SWIRL * Math.log(RMAX / r);
          const px = CX + r * Math.cos(a);
          const py = CYD + dropAt(r) + r * SQ * Math.sin(a);
          const pt = px.toFixed(1) + " " + py.toFixed(1);
          const keep = r >= RH || py < lipY(px) - 2;
          if (keep) {
            d += (pback ? "L" : "M") + pt;
            pback = true;
          } else pback = false;
          if (Math.sin(a) > 0.08 && r < RH + 160 && r >= RH) {
            fd += (pin ? "L" : "M") + pt;
            pin = true;
          } else pin = false;
        }
        el.setAttribute("d", d);
        const fe = fSpokes[j];
        if (fe) {
          if (fd) {
            fe.setAttribute("d", fd);
            fe.setAttribute("opacity", "0.92");
            fe.removeAttribute("display");
          } else fe.setAttribute("display", "none");
        }
      }

      if (shadowRef.current) {
        const se = shadowRef.current;
        se.setAttribute("cx", String(CX));
        se.setAttribute("cy", (cyRH + RH * SQ * 0.15).toFixed(1));
        se.setAttribute("rx", (RH * 1.25).toFixed(1));
        se.setAttribute("ry", (RH * SQ * 1.3).toFixed(1));
        se.setAttribute("opacity", HOLE_SHADOW.toFixed(3));
      }

      const cut: [string, string][] = [
        ["430", "180"],
        ["1090", "180"],
        ["1090", "1420"],
        [String(CX + RH), "1420"],
        [String(CX + RH), cyRH.toFixed(1)],
      ];
      for (let i = 1; i < 14; i++) {
        const xx = CX + RH - (i / 14) * 2 * RH;
        cut.push([xx.toFixed(1), lipY(xx).toFixed(1)]);
      }
      cut.push([String(CX - RH), cyRH.toFixed(1)], [String(CX - RH), "1420"], ["430", "1420"]);
      if (cutRef.current) {
        cutRef.current.setAttribute("d", "M" + cut.map((p) => p[0] + " " + p[1]).join("L") + "Z");
      }
      if (handClipRef.current) {
        const { ix, iy, iw, ih } = variant;
        const poly = cut
          .map(
            (p) =>
              (((Number(p[0]) - ix) / iw) * 100).toFixed(2) +
              "% " +
              (((Number(p[1]) - iy) / ih) * 100).toFixed(2) +
              "%",
          )
          .join(",");
        handClipRef.current.style.clipPath = "polygon(" + poly + ")";
      }
      if (handRef.current) {
        const bob = Math.sin(ph * Math.PI * 2) * 0.63;
        handRef.current.style.transform = "translateY(" + bob.toFixed(3) + "%)";
        if (maskRef.current) {
          maskRef.current.setAttribute("transform", "translate(0 " + (bob * 11.13).toFixed(2) + ")");
        }
      }
    }

    function tick(now: number) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      t += dt;
      draw();
      raf = requestAnimationFrame(tick);
    }

    draw();
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [variant]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        width: size,
        maxWidth: "100%",
        aspectRatio: "1163 / 1231",
      }}
    >
      <svg
        viewBox="266 192 1163 1231"
        width="100%"
        height="100%"
        style={{ display: "block", overflow: "visible", position: "absolute", inset: 0 }}
      >
        <defs>
          <clipPath id="okd-panel">
            <rect x={291} y={705} width={1113} height={693} />
          </clipPath>
          <clipPath id="okd-armcut">
            <path ref={cutRef} d="M266 192L1429 192L1429 1423L266 1423Z" />
          </clipPath>
          <mask id="okd-hand" maskUnits="userSpaceOnUse" x={266} y={192} width={1163} height={1231}>
            <rect x={266} y={192} width={1163} height={1231} fill="#fff" />
            <path
              ref={maskRef}
              clipPath="url(#okd-armcut)"
              fill="#000"
              d="M569 211L583 213L598 220L626 248L636 271L636 290L655 312L678 365L682 384L680 402L699 419L719 454L725 460L730 455L735 432L732 422L738 414L740 406L738 396L743 396L765 377L824 360L832 353L850 354L857 361L911 378L927 394L948 374L953 374L963 384L970 398L969 408L972 420L984 445L995 461L1018 486L1023 498L1025 513L1020 541L1013 561L1016 574L1009 582L1009 595L1013 602L1013 635L1009 642L1009 666L1015 676L1010 685L1011 699L1014 704L1013 719L1009 730L1008 754L1010 764L1002 782L1002 797L993 810L975 864L976 874L971 881L961 934L964 947L959 958L957 982L957 1021L959 1024L956 1028L954 1095L958 1102L954 1109L953 1121L953 1163L954 1177L958 1184L955 1191L957 1278L965 1303L959 1309L954 1309L936 1317L876 1323L813 1323L750 1315L744 1310L734 1308L728 1302L738 1285L742 1267L749 1254L754 1230L762 1195L763 1172L766 1168L777 1112L778 1103L772 1091L777 1083L776 1069L781 1065L779 1021L776 1016L779 1010L778 980L775 955L767 939L768 933L750 906L740 901L734 887L723 875L723 869L685 813L673 800L671 791L607 700L589 668L526 570L484 487L476 462L473 458L470 458L473 449L466 428L463 406L468 402L475 402L489 404L497 409L520 435L530 456L536 459L539 467L534 476L533 488L554 507L558 507L558 511L568 526L581 542L585 542L590 554L600 562L602 572L631 598L636 593L636 582L631 570L620 554L615 552L615 547L608 535L601 534L597 528L592 518L593 511L588 498L582 489L578 489L574 468L562 448L553 442L553 434L541 420L522 388L505 351L474 299L470 287L467 286L469 277L475 277L487 265L487 258L498 257L516 267L530 281L563 336L568 338L593 383L600 390L607 392L609 384L600 368L602 362L597 344L591 341L583 316L586 307L564 243L554 226L555 217L563 217L569 211Z"
            />
          </mask>
        </defs>
        <defs>
          <radialGradient id="okd-holeshadow">
            <stop offset="0%" stopColor={variant.strokeColor} stopOpacity={1} />
            <stop offset="55%" stopColor={variant.strokeColor} stopOpacity={0.82} />
            <stop offset="100%" stopColor={variant.strokeColor} stopOpacity={0} />
          </radialGradient>
        </defs>
        <g mask="url(#okd-hand)">
          <g
            ref={fieldRef}
            clipPath="url(#okd-panel)"
            fill="none"
            stroke={variant.strokeColor}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <ellipse
            ref={shadowRef}
            clipPath="url(#okd-panel)"
            fill="url(#okd-holeshadow)"
            cx={844}
            cy={1200}
            rx={330}
            ry={185}
            opacity={0}
          />
          <rect
            x={287.5}
            y={701.5}
            width={1120}
            height={700}
            fill="none"
            stroke={variant.strokeColor}
            strokeWidth={11}
          />
        </g>
      </svg>
      <div
        ref={handClipRef}
        style={{
          position: "absolute",
          left: variant.handClip.left,
          top: variant.handClip.top,
          width: variant.handClip.width,
          height: variant.handClip.height,
        }}
      >
        <img
          ref={handRef}
          src={variant.handSrc}
          alt=""
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            willChange: "transform",
            filter: variant.handInvert ? "invert(1)" : undefined,
          }}
        />
      </div>
      <svg
        viewBox="266 192 1163 1231"
        width="100%"
        height="100%"
        style={{ display: "block", overflow: "visible", position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <defs>
          <clipPath id="okd-panel-front">
            <rect x={291} y={705} width={1113} height={693} />
          </clipPath>
        </defs>
        <g
          ref={frontRef}
          clipPath="url(#okd-panel-front)"
          fill="none"
          stroke={variant.strokeColor}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
