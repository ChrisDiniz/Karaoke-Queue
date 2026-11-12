# G2.1 — decisão final e perfil2

Fixtures públicas, código de laboratório 00001234, sem segredo de dispositivo real. O arquivo final-profile-vector.json contém sessionKey/R de uma sessão fictícia para validação byte a byte; nunca usar no produto. Não é captura de operação de usuário.

- decision-processes.json / decision-processes-electron.json: OPAQUE real em dois processos OS distintos por cenário. Success, código errado, fingerprint/nonce/geração diferentes, confirmações alteradas, replay e descarte de estado passaram. Os casos cancel/timeout testam descarte explícito; não relógio/coordinator de produção. Modelo de reserva simultânea é limitado e não prova locking em FS ou IPC real.
- final-profile-vector.json: CTX/T/TH, KE1–3, árvore e MACs do perfil final `kq-pair/2`. Randomness interna do OPAQUE é real; o vetor preservado permite verificar aplicação, não impor deterministicidade ao PAKE.
- decision-primitives.json / decision-primitives-electron.json: Python cryptography/hashlib/HMAC, independente de node:crypto, confere CTX/T, HKDF, root/commit e ambas confirmações. Não é um oráculo independente de OPAQUE.
- final-recovery-vector.json / decision-receipts.json / decision-receipts-electron.json: cinco receipts e consulta bound sem pairingId, digest de prepare recuperado e alteração rejeitada; bytes conferidos entre Python e Node. Modelo criptográfico, não store real.

Pré-requisito: tarball exato @serenity-kit/opaque1.1.0 já qualificado em `/tmp/kq-g21-opaque-final/opaque/package`, conforme README de opaque-final; nenhuma dependência permanente. Da raiz:

```sh
node scripts/validation/g21-final-decision.cjs /tmp/kq-g21-decision /tmp/kq-g21-opaque-final/opaque/package
python3 scripts/validation/g21-final-vector.py /tmp/kq-g21-decision
node scripts/validation/g21-final-receipts.cjs /tmp/kq-g21-decision
```

Protocolo real/criptografia sem mocks; mensagens neste teste são encaminhadas pelo harness via IPC de processos, não pelas rotas do produto. A prova anterior de TLS-terminating MITM, worker e ASAR permanece em opaque-final/ e b3-*.json. Não repeti-la sem motivo. Nenhum teste de consentimento/arquivo operacional ou homologação Windows é inferido.

O contrato final escolhe aceitar ausência do AKE completo RFC na API e auditoria histórica/deltas como riscos residuais proporcionais, sustentado pelo conjunto de testes/proveniência/revisão. Isso não declara esses testes ausentes PASS. Implementação futura deve cumprir gates de produto, parsing, writer/CAS, cofre, races e UI local aprovada. A decisão que falta é do proprietário; não outra pesquisa genérica de algoritmos.

Para repetir no Node do Electron45, executar o harness com ELECTRON_RUN_AS_NODE=1 e diretório de saída separado; o fork herda o executável/ambiente e inicia dois processos Electron Run-As-Node independentes. Foram preservados relatórios separados; isso não é UI de produção ou Windows nativo. O vetor Electron também é fixture pública, não segredo de usuário.
