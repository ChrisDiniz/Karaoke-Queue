# G2.1 — evidências isoladas, 2026-11-12

Fixtures públicas; nenhuma chave ou código real. Não são dependências de produto.

- node-result.json / electron-result.json: runtime, assertions, integridade e custo.
- srp-vector.json: vetor HAP upstream comparado com HAP-python e S/K pysrp.
- protocol-srp-vector.json: fixture de protocolo com salt32/código8 para K/provas.
- binding-vector.json: T bruto (E com uint32be de comprimentos), TH e árvore derivada.
- receipt-vector.json: D e cadeia dos cinco MACs.
- recovery-vector.json: bytes e MACs de consulta/resposta com nonce/direções separados.
- primitives-result.txt, tls-result.json, recovery-result.json: alcance/limites das experiências.

Reprodução: preparar diretório isolado como `/tmp/kq-g21-qualification`, baixar metadata `https://registry.npmjs.org/fast-srp-hap/2.0.4` como metadata.json e tarball declarado nela como package.tgz; extrair para package/. Baixar source.tgz de `https://codeload.github.com/homebridge/fast-srp/tar.gz/df6cdb6583024a3e4379501f4689777f02aa4d8c` e extrair mantendo nome do diretório. Baixar TypeScript 4.4.3 de `https://registry.npmjs.org/typescript/-/typescript-4.4.3.tgz` (SHA256 aea423e9f38bab0b12a3598eed07cae111eb6663dc29987e0b47389b42f3c017), extrair em tsc/package; não executar lifecycle/npm install.

Baixar os dois módulos externos nos commits/SHAs registrados na proposta: pyhap/hsrp.py como hsrp-pinned.py, srp/_pysrp.py como pysrp.py. Python precisa de six e cryptography (ambiente disponível: 1.16.0/41.0.7); não instalar no projeto. Verificar hashes antes de executar. O harness fornece somente a conversão int→bytes como shim utilitário do HAP-python; não altera o SRP. Biblioteca independente não se torna dependência/alternativa aprovada do produto.

Executar da raiz do repositório, em sequência (outputs de custo variam):

```sh
node scripts/validation/g21-qualification.cjs /tmp/kq-g21-qualification
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron scripts/validation/g21-qualification.cjs /tmp/kq-g21-qualification
node scripts/validation/g21-recovery.cjs /tmp/kq-g21-qualification
python3 scripts/validation/g21-primitives.py /tmp/kq-g21-qualification
node scripts/validation/g21-tls.cjs /tmp/kq-g21-qualification
```

O último usa selfsigned já presente no projeto apenas para certs fictícios e precisa permissão de sockets loopback. Não alterar firewall. Geração não persiste certificados/chaves no repo. Modelos não comprovam store/IPC/G2 de produção; Run-As-Node não é E2E de UI Electron. Receipts/HKDF e fixture de transcript foram conferidos entre Node e Python; o recovery wire completo e cada falha de syscall ainda exigem testes na implementação futura.

## Retomada final B3

Evidências adicionais, sem substituir os resultados B1/B2:

- `b3-node.json`, `b3-electron.json`: SRP real em worker contra a fixture já qualificada; supervisor responsivo, cancelamento sem resultado, worker posterior funcional; OPAQUE real com negativos; microbenchmark M1 sem alegação de segurança de timing.
- `b3-artifacts.json`: versões, URLs, integrity/SHA256 de alternativas, declaração de proveniência OPAQUE com digest conferido (assinatura **não verificada**) e smoke SPAKE2 do mesmo provider.
- `b3-policy-model.json`: modelo puro de budget persistido/boot monotônico e fronteiras de renovação. Não é implementação G2, teste de NTFS/energia ou cofre.

Reprodução isolada em `/tmp/kq-g21-b3`:

1. Obter fast-srp-hap 2.0.4 como package.tgz e extrair em package/ (integrity B1 é conferida pelo harness worker).
2. Obter metadata de versão `https://registry.npmjs.org/@serenity-kit%2fopaque/1.1.0` como opaque-metadata.json, `https://registry.npmjs.org/secure-remote-password/0.3.1` como srp-alt-metadata.json e `https://registry.npmjs.org/spake2-wasm/0.2.0` como spake-metadata.json. Baixar seus tarballs nas URLs de dist como opaque.tgz/srp-alt.tgz/spake.tgz; extrair em opaque/package, srp-alt/package e spake/package. Não executar npm install/lifecycle scripts. Artefatos ficam somente em /tmp.
3. Obter `https://registry.npmjs.org/-/npm/v1/attestations/@serenity-kit%2fopaque@1.1.0`, decodificar o payload base64 DSSE da attestation predicateType `https://slsa.dev/provenance/v1` como opaque-provenance-payload.json. Isso extrai uma declaração; não valida assinaturas ou cadeia Sigstore.
4. Da raiz do repo, executar em sequência:

```sh
node scripts/validation/g21-b3-artifacts.cjs /tmp/kq-g21-b3
node scripts/validation/g21-b3-worker.cjs /tmp/kq-g21-b3
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron scripts/validation/g21-b3-worker.cjs /tmp/kq-g21-b3
node scripts/validation/g21-b3-policy-model.cjs /tmp/kq-g21-b3
```

Não há dependência npm de produção nova. OPAQUE usa WASM inline e SPAKE2 WASM separado; custo de Argon2/WASM é medido no worker. OPAQUE same-provider smoke não é qualificação RFC9807; não há novos vetores independentes da alternativa nesta retomada. Os vetores independentes SRP anteriores continuam válidos. Não adotar a alternativa sem novo perfil/binding versionado e aprovação.

Na execução registrada, uma troca SRP síncrona atrasou o supervisor em ~1,15 s no Node e ~1,08 s no Electron Run-As-Node. Durante workload em workers, o maior intervalo observado do sampler de 10 ms foi ~14,6 ms; terminate levou ~3,6–5,8 ms e restaram zero workers ativos. São medidas deste host, não limites garantidos em hardware Windows nem evidência de tempo constante. O sampler mede tempo; mensagens ready/started/result e eventos exit coordenam o teste, sem sleeps de sincronização.

## Qualificação focal OPAQUE1.1.0

Ver [evidências finais](opaque-final/README.md): proveniência agora verificada com Sigstore, dois vetores oficiais parciais, HTTPS/MITM real e ASAR/worker. Substitui apenas a limitação anterior de assinatura não verificada; não converte os demais gates em PASS. Decisão de adoção NO-GO, conforme seção13 do contrato.

## Decisão arquitetural FINAL

[Perfil recomendado](../../g2-1-final-pairing-profile.md), [teste final em processos](final-decision/README.md): OPAQUE1.1.0/kq-pair/2, recomendação proporcional apta à aprovação do proprietário. Não apaga a investigação anterior nem converte AKE integral não executado em PASS. Complementa B1/B2/TLS/worker/ASAR existentes com CTX/confirmations versionados e checagem independente de primitivas. Implementação não iniciada.
