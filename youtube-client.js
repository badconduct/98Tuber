"use strict";

let innertubePromise = null;

function createEvaluator(Jinter) {
  return async (data, environment) => {
    const properties = [];
    if (environment.n) properties.push(`n: exportedVars.nFunction(${JSON.stringify(environment.n)})`);
    if (environment.sig) properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(environment.sig)})`);
    const code = `${data.output}\nvar result = { ${properties.join(", ")} };\nresult;`;
    const interpreter = new Jinter(code);
    for (const [key, value] of Object.entries(environment)) interpreter.defineObject(key, value);
    interpreter.defineObject("Object", {
      assign(target, ...sources) {
        const destination = target || {};
        for (const source of sources) {
          if (!source || typeof source !== "object") continue;
          for (const key in source) destination[key] = source[key];
        }
        return destination;
      },
    });
    for (const [name, value] of Object.entries({
      RegExp, String, Number, Array, Math, Date, JSON, Promise, Error, parseInt, parseFloat,
    })) interpreter.defineObject(name, value);
    return interpreter.evaluate(code);
  };
}

async function createInnertube() {
  const [{ Innertube, Platform, UniversalCache }, { Jinter }] = await Promise.all([
    import("youtubei.js"),
    import("jintr"),
  ]);
  Platform.shim.eval = createEvaluator(Jinter);
  return Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    client_type: "ANDROID",
  });
}

function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = createInnertube();
    innertubePromise.catch(() => { innertubePromise = null; });
  }
  return innertubePromise;
}

module.exports = { createEvaluator, getInnertube };
