import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TOKEN_HEADER, type ScanReport } from '@widedoor/report';
import { startLocalServer } from '../src/app.ts';
import { withoutLocalPaths, type ScanInputs } from '../src/engine.ts';

/*
 * Report error text names no absolute path: the real engine and a real scan
 * job, with a PDF scanner that fails each file and quotes the path it was
 * given (the uploaded PDF's private stage) and a temp file of its own.
 */

vi.mock('@widedoor/pdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@widedoor/pdf')>();
  const { join: joinPath } = await import('node:path');
  const { tmpdir: tmp } = await import('node:os');
  return {
    ...real,
    dockerCommand: () => undefined,
    PdfScanner: { create: async () => ({ runner: undefined }) },
    scanPdfs: async (scope: { files?: readonly string[] }, options: { baseDir: string }) => ({
      engines: {
        verapdf: { name: 'verapdf', version: '1.30.3', runner: null, description: null },
        widedoor: { name: 'widedoor', version: '0.2.0' },
      },
      files: [],
      assets: [],
      findings: [],
      informational: [],
      errors: (scope.files ?? []).map((file) => ({
        uri: file,
        code: 'scan-failed',
        engine: 'verapdf',
        message: `could not parse '${joinPath(options.baseDir, file)}' (copy ${joinPath(tmp(), 'verapdf-1', 'in.pdf')})`,
      })),
      warnings: [`read ${joinPath(options.baseDir, String(scope.files?.[0]))}`],
    }),
  };
});

const TOKEN = 'paths-token_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const tmp = mkdtempSync(join(tmpdir(), 'widedoor-report-paths-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function call(port: number, method: string, path: string, body?: Buffer | string, type?: string) {
  return new Promise<{ status: number; text: string }>((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        setHost: false,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          [TOKEN_HEADER]: TOKEN,
          ...(type ? { 'content-type': type } : {}),
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.once('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('report error text', () => {
  it('names an uploaded PDF whose scan failed by its upload name, and no temp path', async () => {
    const root = join(tmp, 'root');
    mkdirSync(root);
    const server = await startLocalServer({
      files: new Map(),
      root: { dir: root },
      token: TOKEN,
      env: {},
    });
    try {
      const uploaded = await call(
        server.port,
        'POST',
        '/api/uploads?kind=pdf&name=annual-report.pdf',
        Buffer.from('%PDF-1.7\n%%EOF\n'),
        'application/pdf',
      );
      expect(uploaded.status, uploaded.text).toBe(201);
      const { id } = JSON.parse(uploaded.text) as { id: string };
      const started = await call(
        server.port,
        'POST',
        '/api/scans',
        JSON.stringify({ pdfs: [id] }),
        'application/json',
      );
      expect(started.status, started.text).toBe(202);
      const job = JSON.parse(started.text) as { id: string };
      let view: { status: string; report?: ScanReport; error?: string } = { status: 'queued' };
      for (let i = 0; i < 500 && (view.status === 'queued' || view.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 10));
        view = JSON.parse((await call(server.port, 'GET', `/api/scans/${job.id}`)).text);
      }
      expect(view.status, view.error).toBe('done');
      const report = view.report as ScanReport;
      expect(report.errors).toEqual([
        expect.objectContaining({
          uri: 'annual-report.pdf',
          message: "could not parse 'annual-report.pdf' (copy in.pdf)",
        }),
      ]);
      expect(report.warnings).toContain('read annual-report.pdf');
      // The served report and every export carry the same text.
      for (const path of ['/api/report', '/api/export/json', '/api/export/sarif']) {
        const text = (await call(server.port, 'GET', path)).text;
        expect(text, path).toContain('annual-report.pdf');
        // A drive path, not the s:/ of https://.
        expect(text, path).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]/);
        expect(text, path).not.toContain(tmpdir().split('\\').join('\\\\'));
        expect(text, path).not.toContain(tmpdir());
      }
    } finally {
      await server.close();
    }
  });
});

describe('withoutLocalPaths', () => {
  it('names files in the root root-relative and others by name, and keeps asset uris', () => {
    const root = join(tmp, 'site');
    const stage = join(tmp, 'stage');
    const inputs = {
      profile: '508+wcag21aa',
      pdfDocumentType: 'non-web',
      startedAt: new Date(),
      finishedAt: new Date(),
      scope: {},
      pdf: {
        engines: {
          verapdf: { name: 'verapdf', version: '1.30.3', runner: null, description: null },
          widedoor: { name: 'widedoor', version: '0.2.0' },
        },
        assets: [],
        findings: [],
        informational: [],
        errors: [
          {
            uri: join(stage, 'x.pdf'),
            code: 'scan-failed',
            message: `open ${join(root, 'docs', 'a.pdf')} and ${join(stage, 'x.pdf')}`,
          },
        ],
        warnings: [`no ${join(root, 'b.pdf')}`],
        scopeGaps: [`gap at ${join(stage, 'c.pdf')}`],
      },
    } as unknown as ScanInputs;
    const out = withoutLocalPaths(inputs, root, { folders: [stage], others: 'name' });
    expect(out.pdf?.errors[0]).toEqual({
      uri: join(stage, 'x.pdf'),
      code: 'scan-failed',
      message: 'open docs/a.pdf and x.pdf',
    });
    expect(out.pdf?.warnings).toEqual(['no b.pdf']);
    expect(out.pdf?.scopeGaps).toEqual(['gap at c.pdf']);
  });

  it('keeps a path the CLI user typed, and names only temp paths by their name', () => {
    const root = join(tmp, 'site');
    const temp = join(tmp, 'os-temp');
    const typed = join(tmp, 'elsewhere', 'report.pdf');
    const inputs = {
      profile: '508+wcag21aa',
      pdfDocumentType: 'non-web',
      startedAt: new Date(),
      finishedAt: new Date(),
      scope: {},
      pdf: {
        engines: {
          verapdf: { name: 'verapdf', version: '1.30.3', runner: null, description: null },
          widedoor: { name: 'widedoor', version: '0.2.0' },
        },
        assets: [],
        findings: [],
        informational: [],
        errors: [
          {
            uri: typed,
            code: 'scan-failed',
            message: `could not parse ${typed} (copy ${join(temp, 'verapdf-1', 'in.pdf')}, near ${join(root, 'docs', 'a.pdf')})`,
          },
        ],
        warnings: [],
      },
    } as unknown as ScanInputs;
    // As performScan calls it for the CLI.
    const out = withoutLocalPaths(inputs, root, { folders: [temp], others: 'keep' });
    expect(out.pdf?.errors[0]?.message).toBe(
      `could not parse ${typed} (copy in.pdf, near docs/a.pdf)`,
    );
  });
});
