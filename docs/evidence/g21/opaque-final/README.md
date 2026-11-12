# OPAQUE 1.1.0 — qualificação focal

Registro histórico da etapa §13. A recomendação arquitetural final, com trade-offs proporcionais explícitos, está no [perfil final](../../../g2-1-final-pairing-profile.md); os resultados deste diretório permanecem válidos.

Dados públicos de teste. Nenhuma credencial operacional. Os resultados B1/B2 e B3 anteriores não foram substituídos.

- `provenance-result.json`: verificação Sigstore4.1.0, identidade/issuer exigidos, CT/Rekor/cadeia e subject do tarball.
- `source-comparison.json`: hashes e checkpoints históricos; o checkpoint2023 **não é alegado como commit auditado**.
- `advisory-query.json`: consulta OSV de duas versões, não inventário completo de transitivas.
- `rfc-registration-vectors.json`: somente dados necessários dos vetores oficiais RFC9807 C.1.1/C.1.2; resposta de registro determinística, não AKE completo.
- `opaque-final-node.json` / `opaque-final-electron.json`: troca real, negativos e TLS com dois certificados, métricas de processo.
- `asar-result.json`: pacote em ASAR, worker Electron45 e troca bilateral. Não é pacote do produto/Windows.

Reprodução em `/tmp/kq-g21-opaque-final` (ROOT), preservando o diretório anterior `/tmp/kq-g21-b3` (ARTIFACTS):

1. Obter OPAQUE1.1.0/tarball e attestations conforme README pai. Copiar sua pasta `opaque/package` para ROOT/opaque/package; conferir integrity do tarball conforme B3. Obter RFC9807.txt de `https://www.rfc-editor.org/rfc/rfc9807.txt` em ROOT/rfc9807.txt.
2. Instalar exclusivamente em ROOT/verify o verificador oficial: `npm install --prefix /tmp/kq-g21-opaque-final/verify --ignore-scripts --no-audit --no-fund sigstore@4.1.0`. Não mudar package.json/lock do projeto. O cache TUF é ROOT/tuf-cache. A verificação exige rede para atualizar raízes/metadados, sem credenciais.
3. Da raiz do repositório:

```sh
python3 scripts/validation/g21-opaque-rfc-vectors.py /tmp/kq-g21-opaque-final
node scripts/validation/g21-opaque-provenance.cjs /tmp/kq-g21-opaque-final /tmp/kq-g21-b3
node scripts/validation/g21-opaque-final.cjs /tmp/kq-g21-opaque-final
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron scripts/validation/g21-opaque-final.cjs /tmp/kq-g21-opaque-final
```

Os testes HTTPS precisam de sockets loopback. Só usam certificados fictícios; não alterar firewall. Provas/registro OPAQUE não são mocks. Mudar identity/version/purpose no PoC altera identifiers nativos: isso não é aprovação de um encoding B2 novo.

Para o probe ASAR, criar ROOT/asar-app/opaque/index.js copiando somente o CJS publicado `opaque/package/cjs/index.js` (WASM inline). Copiar `scripts/validation/g21-opaque-asar-probe.cjs` para ROOT/asar-app/probe.cjs. Empacotar essa pasta em ROOT/opaque-probe.asar usando `@electron/asar.createPackage` já disponível no projeto, sem novo pacote/dependência. Executar:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron /tmp/kq-g21-opaque-final/opaque-probe.asar/probe.cjs
```

Fontes comparadas: `https://codeload.github.com/serenity-kit/opaque/tar.gz/ca1cb22f03b9e456159ce367e2975124f87f5ad8` e checkpoint `6714925d4c65efa1d4b2ded0b5935778b596a6e4`. Inspecionados Cargo.toml/src/lib.rs/release workflow. Core de referência inspecionado em `https://static.crates.io/crates/opaque-ke/opaque-ke-4.0.0.crate`; não prova backend/transitivas resolvidos do WASM e não foi compilado. Não há Rust/cargo ou compilador C disponível nesta sessão; não foi instalado toolchain adicional para produzir um oráculo AKE completo. Não houve reimplementação de matemática criptográfica ou fork para trocar KSF/context/RNG.

A conclusão de adoção é NO-GO nesta rodada: evidências de registro e runtime positivas, porém AKE completo da suite real/delta pós-auditoria não qualificados. O registro local evita o tráfego inicial não autenticado; TLS candidato sozinho não supre a autenticação de registro da RFC. Não há incompatibilidade inevitável com código8/UX demonstrada. Nenhum protocolo foi habilitado ou entregue ao Luna como aprovado.
