import { EventType } from "../../../engine/event.js";
import type { ListPullRequestFiles } from "../../../engine/model/pull-request.js";
import type { RuleContext } from "../../../engine/model/rule-context.js";
import { type CheckOutcome, check } from "../../../engine/rule.js";
import { fetchIntegrationManifest } from "../../../helpers/integration-manifest.js";
import { pickedTypeLabels } from "../helpers/change-type.js";
import { type Bump, singleBump, touchesCode } from "../helpers/dependency-bump.js";
import { fetchResultingIntegrationManifest } from "../helpers/integration-manifest.js";
import { isReleasePR } from "../helpers/release-pr.js";
import { styleProblems } from "../helpers/title-style.js";

/** Lists the integrations without a quality scale, so adding one changes it. */
const HASSFEST_LIST = "script/hassfest/quality_scale.py";

const COMPONENT_FILE = /^homeassistant\/components\/([^/]+)\/(.+)$/;

type HandledEvent =
  | EventType.PULL_REQUEST_OPENED
  | EventType.PULL_REQUEST_REOPENED
  | EventType.PULL_REQUEST_EDITED
  | EventType.PULL_REQUEST_SYNCHRONIZE
  | EventType.ON_DEMAND;

/** The title a PR of some shape should have. */
interface Expectation {
  matches: (title: string) => boolean;
  suggestion: string;
  /** Follows "Rename this PR to `…`". */
  advice?: string;
  /** The bot can't tell whether the PR is what its shape suggests. */
  uncertain?: boolean;
}

type ChangedFile = ListPullRequestFiles[0];

interface ComponentFile {
  domain: string;
  path: string;
  file: ChangedFile;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function componentFiles(files: ListPullRequestFiles): ComponentFile[] {
  return files.flatMap((file) => {
    const match = COMPONENT_FILE.exec(file.filename);
    return match ? [{ domain: match[1], path: match[2], file }] : [];
  });
}

/** Own packages are named without this prefix: `Bump intents to …`. */
const OWN_PREFIX = "home-assistant-";

/** Frontend releases are titled `Update frontend to …`. */
const FRONTEND = "home-assistant-frontend";

function bumpMatcher({ name, version }: Bump): RegExp {
  const pattern = (text: string) => escapeRegExp(text).replace(/\\?[-_.]/g, "[-_.]");
  const names = name.startsWith(OWN_PREFIX)
    ? `(?:${pattern(OWN_PREFIX)})?${pattern(name.slice(OWN_PREFIX.length))}`
    : pattern(name);
  const verb = name === FRONTEND ? "(?:bump|update)" : "(?:bump|downgrade)";
  return new RegExp(`^${verb} ${names} (?:from \\S+ )?to v?${escapeRegExp(version)}$`, "i");
}

function bumpTitle(files: ListPullRequestFiles): Expectation | undefined {
  const bump = singleBump(files);
  if (!bump) return;
  // A bump next to code can be a feature or fix that happens to need it.
  const uncertain = touchesCode(files);
  const matcher = bumpMatcher(bump);
  return {
    matches: (title) => matcher.test(title),
    suggestion: `Bump ${bump.name} to ${bump.version}`,
    advice:
      (uncertain ? " if the bump is its purpose," : "") +
      " and explain why the bump is needed in the description",
    uncertain,
  };
}

async function newIntegrationTitle(
  ctx: RuleContext<HandledEvent>,
  components: ComponentFile[],
): Promise<Expectation | undefined> {
  // Every integration has a manifest, virtual ones included.
  const added = components.filter((c) => c.path === "manifest.json" && c.file.status === "added");
  if (added.length !== 1) return;
  const manifest = await fetchResultingIntegrationManifest(ctx, added[0].domain);
  const virtual = manifest?.integration_type === "virtual" ? " virtual" : "";
  return {
    matches: (title) => {
      const name = /^Add (?!(?:a |the )?new )(\S.*) integration$/.exec(title)?.[1];
      return name !== undefined && (!manifest || isSpelledLike(name, manifest.name));
    },
    suggestion: `Add ${manifest?.name ?? added[0].domain}${virtual} integration`,
  };
}

/**
 * A title may use a somewhat different name than the manifest (a longer brand
 * name, "virtual"), but not the same name or a first letter in another case.
 */
function isSpelledLike(name: string, manifestName: string): boolean {
  if (name.toLowerCase() === manifestName.toLowerCase()) return name === manifestName;
  return !/^\p{Ll}/u.test(name) || /^\p{Ll}/u.test(manifestName);
}

/** The tier a manifest patch sets, when the patch changes nothing else. */
export function tierOnlyChange(patch: string): string | undefined {
  const changed = { "+": [] as string[], "-": [] as string[] };
  let tier: string | undefined;
  for (const line of patch.split("\n")) {
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    // The line before a new last key gains a comma.
    const content = line.slice(1).trim().replace(/,$/, "");
    const scale = /^"quality_scale":\s*"([^"]+)"$/.exec(content);
    if (!scale) changed[sign].push(content);
    else if (sign === "+") tier = scale[1];
  }
  const unchanged = changed["+"].sort().join("\n") === changed["-"].sort().join("\n");
  return unchanged ? tier : undefined;
}

/** Titles for PRs that change nothing but one integration's quality scale. */
async function qualityScaleTitle(
  files: ListPullRequestFiles,
  components: ComponentFile[],
): Promise<Expectation | undefined> {
  const [first] = components;
  if (!first || components.some((c) => c.domain !== first.domain)) return;
  const others = files.filter((f) => !components.some((c) => c.file === f));
  if (others.some((f) => f.filename !== HASSFEST_LIST)) return;

  const rules = components.find((c) => c.path === "quality_scale.yaml");
  const manifest = components.find((c) => c.path === "manifest.json");
  if (components.some((c) => c !== rules && c !== manifest)) return;

  if (manifest) {
    // Rules changed along with the tier are there to reach it.
    const tier = manifest.file.status === "modified" && tierOnlyChange(manifest.file.patch ?? "");
    return tier ? namedTitle(`Set quality scale to ${tier} in`, first.domain) : undefined;
  }
  if (rules?.file.status === "added") return namedTitle("Add quality scale file to", first.domain);
  if (rules?.file.status === "modified") {
    return namedTitle("Update quality scale rules in", first.domain);
  }
}

async function configFlowTitle(components: ComponentFile[]): Promise<Expectation | undefined> {
  const added = components.filter((c) => c.path === "config_flow.py" && c.file.status === "added");
  return added.length === 1 ? namedTitle("Add config flow to", added[0].domain) : undefined;
}

/** `<text> <integration>`, with the name an existing integration has on dev. */
async function namedTitle(text: string, domain: string): Promise<Expectation> {
  const name = (await fetchIntegrationManifest(domain))?.name;
  return {
    matches: (title) => (name ? title === `${text} ${name}` : title.startsWith(`${text} `)),
    suggestion: `${text} ${name ?? domain}`,
  };
}

async function expectedTitle(
  ctx: RuleContext<HandledEvent>,
  body: string | null,
): Promise<Expectation | undefined> {
  const files = await ctx.target.files();
  if (pickedTypeLabels(body).includes("dependency")) {
    const bump = bumpTitle(files);
    if (bump) return bump;
  }
  const components = componentFiles(files);
  const addsManifest = components.some(
    (c) => c.path === "manifest.json" && c.file.status === "added",
  );
  if (addsManifest) return newIntegrationTitle(ctx, components);
  return (await qualityScaleTitle(files, components)) ?? (await configFlowTitle(components));
}

async function evaluate(ctx: RuleContext<HandledEvent>): Promise<CheckOutcome> {
  const pr = ctx.target;
  if (await isReleasePR(pr)) {
    return { status: "skip", message: "Not checked on release PRs." };
  }
  // Not `allowBots: false`: that looks at who sent the event, and a maintainer
  // pushing to or editing a bot's PR must not subject it to this check.
  if ((await pr.authorLogin()).endsWith("[bot]")) {
    return { status: "skip", message: "Not checked on bot PRs." };
  }

  const title = (await pr.title()).trim();
  if (/^revert\b/i.test(title)) return { status: "skip", message: "Not checked on reverts." };

  const expected = await expectedTitle(ctx, await pr.body());
  if (expected && !expected.matches(title)) {
    return {
      status: expected.uncertain ? "warn" : "fail",
      message: `Rename this PR to \`${expected.suggestion}\`${expected.advice ?? ""}.`,
    };
  }

  const problems = styleProblems(title);
  return problems.length > 0
    ? { status: "fail", message: problems.join("\n") }
    : { status: "pass", message: "The title is clear." };
}

export const title = check({
  id: "title",
  title: "PR title",
  description:
    "Fails dependency bumps, new integrations, config flows and quality scale changes that " +
    "aren't titled in the usual form, and any title with a prefix, a lowercase first letter, " +
    "a trailing dot or an issue number.",
  events: [
    EventType.PULL_REQUEST_OPENED,
    EventType.PULL_REQUEST_REOPENED,
    EventType.PULL_REQUEST_EDITED,
    EventType.PULL_REQUEST_SYNCHRONIZE,
    EventType.ON_DEMAND,
  ],
  evaluate,
});
