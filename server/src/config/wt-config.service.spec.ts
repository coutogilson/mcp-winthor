import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WtConfigService } from './wt-config.service';

describe('WtConfigService', () => {
  let dir: string;
  let service: WtConfigService;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(() => {
    // O data dir precisa ser temporário: este spec apagava
    // `server/data/config.json`, que é a configuração REAL de quem está usando
    // o app — rodar os testes durante o uso derrubava o login salvo.
    dir = mkdtempSync(join(tmpdir(), 'wtai-config-'));
    process.env.WTA_DATA_DIR = dir;
    service = new WtConfigService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  it('hashes password with WTA MD5 uppercase rule', () => {
    expect(service.md5Wta('teste')).toBe('99A29DC8105FD2FA39D8CDC04733938D');
  });

  it('persists config without plain password', () => {
    const saved = service.saveFromForm({
      winthorBaseUrl: 'http://10.0.0.242:8181/',
      login: 'demo',
      senha: 'teste',
    });

    expect(saved.winthorBaseUrl).toBe('http://10.0.0.242:8181');
    expect(saved.login).toBe('demo');
    expect(saved.senhaMd5).toBe('99A29DC8105FD2FA39D8CDC04733938D');
    expect(service.isConfigured()).toBe(true);
  });

  it('rejects invalid base URL with path', () => {
    expect(() =>
      service.saveFromForm({
        winthorBaseUrl: 'http://host/path',
        login: 'demo',
        senha: 'x',
      }),
    ).toThrow(/caminho/);
  });
});
