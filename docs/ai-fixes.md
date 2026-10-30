# AI fix suggestions

Widedoor can ask an AI model for a suggested fix for each failed check. It is off by default.
You use your own Claude (Anthropic) or OpenAI key. The suggestions are a separate file next to
the report. They never change a result in the report, and they never change the exit code.

Suggestions are AI-generated. Review each one before you use it.

## Turn it on

There are three ways.

- **For one scan:** add `--ai-fixes` to `widedoor scan`. The suggestions run after the reports
  are written.
- **For every scan:** set `ai.enabled: true` in `widedoor.config.yaml`.
- **For a report you already have:** run `widedoor suggest --report <file>`. It reads the
  `report.json` and does not scan again.

Each way writes `ai-suggestions.json` and `ai-suggestions.html` next to the report (or to
`--out` for `widedoor suggest`).

In `widedoor ui`, set `ai.enabled: true` in the config of the root folder and start
`widedoor ui` with the key in its environment. The Report screen then has a
"Suggest a fix (AI)" button on each failed check and a "Suggest fixes for all" button.

```yaml
# widedoor.config.yaml
ai:
  enabled: true
  provider: anthropic # or openai
  model: claude-opus-5-5 # optional for anthropic; required for openai
  maxGroups: 5
```

The flags `--ai-provider anthropic|openai` and `--ai-model <id>` override `ai.provider` and
`ai.model`. With `anthropic`, the default model is `claude-opus-5-5`. With `openai`, there is no
default: set `ai.model` or `--ai-model`.

## Keys

The key comes from the environment only: `ANTHROPIC_API_KEY` for `anthropic`, or
`OPENAI_API_KEY` for `openai`. No config field, flag or page field takes a key. Widedoor never
prints, logs or writes the key. It refuses a config with a key-shaped field, and a model id that
looks like a pasted key.

Set the key for the current shell only, without it showing on screen.

PowerShell (7.1 or later):

```powershell
$env:ANTHROPIC_API_KEY = Read-Host -MaskInput 'Anthropic API key'
widedoor scan https://example.com/ --ai-fixes
Remove-Item Env:ANTHROPIC_API_KEY
```

Bash:

```sh
read -rs -p 'Anthropic API key: ' ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
widedoor scan https://example.com/ --ai-fixes
unset ANTHROPIC_API_KEY
```

Or in one Bash command, so the key is set for that one run only:

```sh
read -rs -p 'Key: ' k && ANTHROPIC_API_KEY="$k" widedoor scan https://example.com/ --ai-fixes; unset k
```

Do not put the key in a file in the repository, and do not paste it into a chat.

## What is sent

Only failed checks get a suggestion. Checks that need a person to judge (needs review) do not.
Identical problems share one request: the same rule with the same redacted snippet is one
request, and the answer applies to every finding in the group.

For a web page, one request holds:

- the rule id and its WCAG and Section 508 criteria;
- Widedoor's own plain-language text for the rule;
- the redacted CSS selector of the element;
- the redacted HTML snippet of the element (at most 2000 characters after redaction).

For a PDF, one request holds the rule id, the criteria, Widedoor's plain-language text, the
page number and the structure path. No text from the PDF is sent.

Never sent on purpose: the page URL and the hosts of absolute URLs (masked), form values, query
strings, the full page or document, PDF text, and your manual review notes.

The sidecar file lists exactly what each request held, with a count of each redaction.

### What is redacted

Every snippet and selector passes through the redactor before anything is sent. It keeps an
allowlist of attributes and fails closed: markup it cannot follow is dropped with everything
after it.

| Kind             | What happens                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `attribute`      | An attribute not on the allowlist, or with a token-shaped name: dropped.                 |
| `comment`        | An HTML comment: dropped.                                                                |
| `contact-url`    | A mailto:, tel:, sms: or callto: URL: masked whole.                                      |
| `data-json`      | A data-* attribute that holds JSON: dropped.                                             |
| `data-url`       | A data: URL: masked whole.                                                               |
| `email`          | An email address: masked.                                                                |
| `event-handler`  | An on* event handler attribute: dropped.                                                 |
| `field`          | Text in a form field, such as a textarea or a hidden, password or sign-in input: masked. |
| `fragment`       | The #fragment of a URL: masked (a same-page id link stays).                              |
| `hex-token`      | A long run of hex digits: masked.                                                        |
| `host`           | The host of a URL: masked. No page address is ever sent.                                 |
| `jwt`            | A JSON Web Token: masked.                                                                |
| `number`         | A long number, such as an account or card number: masked.                                |
| `phone`          | A phone number: masked.                                                                  |
| `query-string`   | The ?query of a URL, or query parameters in text: masked.                                |
| `script-body`    | The body of a script element: dropped.                                                   |
| `script-url`     | A javascript: or vbscript: URL: masked whole.                                            |
| `structure-type` | A non-standard PDF structure type name: sent as Custom.                                  |
| `style`          | A style attribute: dropped.                                                              |
| `style-body`     | The body of a style element: dropped.                                                    |
| `token`          | A token-shaped word (letters with digits, or mixed case): masked.                        |
| `truncated`      | The snippet was cut (by the scan or at the size limit): the rest is not sent.            |
| `unparsed`       | Markup the redactor cannot follow: dropped with everything after it.                     |
| `url`            | A URL in a selector attribute match: masked.                                             |
| `userinfo`       | A user name or password inside a URL: masked.                                            |
| `uuid`           | A UUID: masked.                                                                          |
| `value`          | A value attribute: dropped.                                                              |

### What redaction does not catch

The redactor masks shapes, not meaning. It does not catch:

- secrets under the 24-character token threshold, or written as one-case words;
- digit runs under 9 digits, and phone numbers under 7 digits;
- names, addresses and other free text, in the visible text and in kept attributes such as
  `alt`, `title`, `aria-label` and `placeholder`;
- path segments written as plain words;
- host names written as text.

Run `--ai-dry-run` first to see exactly what a request holds.

## Dry run

`--ai-dry-run` prints exactly what would be sent, every request in full, and sends nothing. It
needs no key. It works with `widedoor scan` and `widedoor suggest`.

```sh
widedoor suggest --report widedoor-report/report.json --ai-dry-run
```

In `widedoor ui`, a confirm step shows the provider, the model and exactly what will be sent
before the first request. Cancel has the focus.

## Cost and limits

You pay the provider for each request, with your own key. These settings cap a run. Set them in
the `ai` block of the config.

| Setting                   | Default | Range           | What it caps                                            |
| ------------------------- | ------- | --------------- | ------------------------------------------------------- |
| `ai.maxGroups`            | 25      | 1 to 200        | Groups (requests) per run. Groups past it are not sent. |
| `ai.maxRequestsPerMinute` | 10      | 1 to 60         | Requests started in any minute.                         |
| `ai.concurrency`          | 2       | 1 to 4          | Requests in flight at once.                             |
| `ai.maxOutputTokens`      | 4096    | 256 to 16384    | Output tokens per answer.                               |
| `ai.maxInputTokensTotal`  | 200000  | 1000 to 5000000 | Input tokens for the whole run.                         |

A run also stops early, and records why in the sidecar file, when:

- the next request would pass the input token budget;
- 3 errors of the same kind come in a row;
- 3 of the last 5 answers were cut off;
- 6 errors come in a row;
- the provider reports an error that cannot be retried, such as a bad key.

Groups that were not sent are marked "not-sent" with the reason.

## Stopping a run

Press Ctrl+C during the suggestions. Widedoor stops sending new requests, still writes the
suggestions file for what it has, and ends with the scan's own exit code. The reports were
already written. Press Ctrl+C again to stop at once.

`widedoor suggest` does the same: it writes both files and exits 0.

## Prompt injection

A page can hold text that tries to steer the model. Widedoor treats the snippet as data in both
directions.

- The snippet goes inside a tagged block with a random nonce, and the instructions tell the
  model never to follow anything inside it.
- The answer must be JSON that matches a strict schema. An answer with a link, a web address,
  an email address or unsafe markup is refused.
- A patch may only use URLs the snippet already had, relative paths or same-page ids.
- Suggestions are shown as escaped text. Nothing in them is run, applied to a file, fetched or
  made into a link.

At worst, a hostile page gets you a wrong or misleading suggestion, shown as text. Review every
suggestion before you apply it.

## Results never change

AI never touches the scan report. A scan writes its reports first and asks for suggestions
after, and `widedoor suggest` leaves `report.json` byte for byte as it was. Suggestions live only
in `ai-suggestions.json` and `ai-suggestions.html`, and every entry is labeled AI-generated.
The exit code is the scan's own.

## The hosted site

The hosted scanner has no AI. It never loads the AI code, and it answers no AI request.

## First run checklist

1. Run with `--ai-dry-run` first, and read what would be sent.
2. Set a small `ai.maxGroups`, such as 5.
3. Run with `--ai-fixes` and the key in the environment.
4. Open `ai-suggestions.html`. If entries say "the answer was cut off", raise
   `ai.maxOutputTokens`.
5. Review each suggestion before you apply it by hand.
