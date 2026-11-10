# 0007/0001 — G1: Infraestrutura HTTPS/WSS

## Identificação

- Ticket: 0007/0001
- Ticket pai: 0007 — Fase G: Comunicação remota segura
- Etapa canônica: G1
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Criar a base de transporte remoto seguro entre Gestão e Reprodutor.

## Escopo

- Definir contratos versionados, identidade, autenticação/autorização, confiança/certificados, limites de acesso/payload e proteção de credenciais.

## Decisões aprovadas

- Segurança de transporte e credenciais.
- Sem segunda autoridade operacional.

## Pendências

- Definir contratos e modelo de confiança antes de abrir a rede.

## Riscos

- Pairing/certificados e segurança de dispositivos precisam de decisões próprias documentadas na arquitetura.

## Histórico de execução

Planejado. Nenhuma implementação iniciada.

## Validação

Testes de protocolo, autorização, limites, credenciais e falha TLS/WSS em ambiente isolado.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
