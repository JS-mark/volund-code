> ↩ [返回索引 (README)](./README.md) · ← [主章: §19 Plugin Kernel](./19-plugin-kernel.md)

---

## §19a Capability Contract V1：字节、制品、权限与收据

> **状态：ABI-00 CONTRACT DRAFT · NOT SHIPPED。**
>
> **日期：2026-08-21。**
>
> **权威性：**本附录冻结 §19.6–§19.9 所需的 V1 字节级合同。若主章的摘要性描述与本附录冲突，以本附录的更严格规则为准。
>
> **实现边界：**ABI-00 只能交付 private contract package、schema、encoder/verifier 和共享 corpus；不得被 production runtime/native composition import，不得解除 P0-00 production kill switch。

本合同的规范性关键词 **MUST / MUST NOT / SHOULD / MAY** 分别表示必须、禁止、建议和可选。所有 verifier 错误都 fail closed；不存在“尽量解析”、unknown role fallback、默认空权限或签名失败后降级为 local trust。

### 19a.1 合同分层与不可替换事实

V1 使用四类不可互换的数据：

| 类型 | 用途 | 是否进入 ArtifactRef DAG | 典型字段 |
|---|---|---:|---|
| **Raw content** | bundle 内普通文件的原始 bytes | 否 | `contentDigest: RawContentDigestV1` |
| **External identity** | Git/toolchain/runtime 等外部系统标识 | 否 | `externalDigest: ExternalDigestV1` |
| **Canonical payload** | 本合同 strict schema 的 canonical JSON bytes | 是 | `ArtifactRefV1` / `CanonicalPayloadDigestV1` |
| **Authority payload** | K0 签发的 activation/invocation/broker/receipt/event 决策数据 | 收据/event payload 可作 artifact；token 不作 catalog artifact | `AuthorityEnvelopeV1` |

禁止把 `RawContentDigestV1`、`ExternalDigestV1`、`CanonicalPayloadDigestV1` 在 TypeScript/Rust 中表示为同一个可互赋值的 `string`。实现 MUST 使用不同 nominal/newtype，且 API 参数名不得只写泛化的 `digest`。

每个 canonical root 都有唯一 strict schema role、唯一 byte limit 和唯一 domain。一个通过 JSON parser 的值不等于一个通过合同的制品；它还必须通过 raw-byte、canonical re-encode、strict schema、role/media pairing、具名上游基数、完整 closure 和签名/权限验证。

### 19a.2 Canonical JSON V1

#### 19a.2.1 Raw-byte admission

`parseArtifactBytes(expectedSchemaRole, rawBytes)` 和 `parseControlBytes(expectedControlRole, rawBytes)` MUST 先检查 bytes，再生成任何通用 JSON value：

1. `rawBytes` 必须是有效 UTF-8，无 BOM，无 overlong sequence，无 surrogate encoding，无 invalid continuation/truncation。
2. Parser 必须在解码阶段检出 duplicate object key；duplicate按 decoded Unicode scalar key判定，因此 raw token不同但解码同为 `a` 的 `"a"` 与 `"\u0061"` 仍是 duplicate。不得先用“last key wins”的普通 `JSON.parse` 消除证据；完整 JSON syntax error仍按 §19a.2.4 precedence先于 duplicate，escaped/noncanonical key则在语法/duplicate后由 re-encode equality拒绝。
3. Top-level 必须是 object。Schema-defined key 只能使用 ASCII，本版本不允许 open metadata map 或 unknown key。需要可变名称的数据必须表达为具名 entry array，不能把用户字符串变成 object key。
4. 任何层级的 JSON nesting depth 不得超过 **32**；root object 为 depth 1。在分配大型容器前必须执行 root byte limit。
5. 解析后必须立即用 Canonical JSON V1 重新编码；接收制品/权限 bytes 时，`rawBytes` MUST byte-for-byte 等于重新编码结果。等价 JSON 但 bytes 不同也必须拒绝。

#### 19a.2.2 Value domain

V1 只允许 `null`、boolean、string、array、object 和 safe integer：

- Integer 范围是 `[-9007199254740991, 9007199254740991]`，使用最短十进制；禁止 float、decimal point、exponent、`-0`、NaN/Infinity 和超出 safe range 的数。时间使用 UTC Unix milliseconds safe integer，容量/长度使用非负 safe integer。
- Generic canonical string 采用 **no-normalization byte identity**：只要是允许的 Unicode scalar sequence 就保留其原始 UTF-8 bytes；encoder/parser 绝不 NFC/NFD/case-fold。规范等价的两个 normalization forms 是两个不同值、不同 domain bytes 和不同 digest，verifier 不得合并它们。
- 禁止 lone surrogate、NUL、C0 (`U+0000–U+001F`)、C1 (`U+007F–U+009F`)、Unicode noncharacter（`U+FDD0–U+FDEF` 及每个 plane 的 `U+xxFFFE/U+xxFFFF`）和 bidi control（`U+061C`、`U+200E`、`U+200F`、`U+202A–U+202E`、`U+2066–U+2069`）。这些都是固定 numeric ranges，不依赖 Unicode/ICU 版本；其他 assigned 或 unassigned scalar 按 opaque bytes 接受。
- Array 顺序有语义；只有 schema 明确标为 set-like 的 array 才按其指定 key 排序，并拒绝 duplicate。Verifier 不得自行重排后接受非 canonical input。
- Object key 按原始 UTF-8 **unsigned-byte lexicographic** 升序：首个不同 byte较小者在前；若一方是另一方前缀则较短者在前。因 V1 schema key全是 ASCII，这与 ASCII byte order一致。所有 schema-defined set-like sort/dedup key也必须显式复用这个 comparator；TS `Buffer.compare` 与 Rust `[u8]::cmp` 必须由 `a`/`aa`/escaped-key shared vectors证明一致。

所有 decision-bearing identifier、schema key、role、path、DNS/HTTP authority、operation、target triple 和 opaque handle 都由各自 schema 进一步收窄为 ASCII；free-form/user/model text 只能处于明确的 non-decision/untrusted field。SafeDisplay 对 non-ASCII scalar 按 code point 逃逸并带 UTF-8 byte length。因此 byte identity 不产生授权歧义，也无需 Unicode normalization table。TS/Rust 禁止调用 host ICU、`String.prototype.normalize()` 或 locale API；corpus 必须证明 composed/decomposed 等价文本都被按原 bytes 接受但得到不同 digest，并覆盖 unassigned scalar 与固定 deny ranges。

#### 19a.2.3 Encoder bytes

Canonical encoder MUST 产生：

- 无空格、换行或缩进的单一 JSON text，不带末尾换行。
- Object key 按上述 byte order 排序。
- String 只对 `"` 和 `\` 使用两字节 JSON escape；因 control code 已被禁止，不会产生 `\n`、`\t` 或 `\u00xx`。允许的 non-ASCII scalar 以原始 UTF-8 输出，不使用 `\uXXXX`。
- Literal 只能是小写 `null`、`true`、`false`；integer 使用最短十进制。

Artifact/control parser 的 production error object 只允许 `{code, expectedRole, byteOffset?, fieldPath?}` 这类 bounded metadata：`expectedRole` 最多 96 ASCII bytes，`fieldPath` 最多 256 ASCII bytes，offset 是 non-negative safe integer。Error、log、trace、telemetry 和 snapshot MUST NOT 包含 raw bytes、raw string value、raw/content digest、secret、handle/blob id、文件内容或整个 JSON subtree；特别是不能用 raw SHA-256 作为低熵 secret 的可猜测关联值。确需跨内部事件关联时，只能由 K0 产生不可导出的、purpose-separated HMAC commitment，且不得返回 plugin、CLI 或用户可见错误。Corpus metadata 可在 test-only 文件中保存 expected raw digest，但 production error API 没有该字段。

#### 19a.2.4 Closed error codes and precedence

`CapabilityContractErrorCodeV1` 是 pure byte/schema/closure verifier 的 closed enum；下列数字是 stable registry id，不是假设所有 API 都能共用的一条执行顺序：

1. `contract.input-too-large`
2. `contract.utf8-invalid`
3. `contract.bom-forbidden`
4. `contract.json-syntax`
5. `contract.duplicate-key`
6. `contract.value-domain`
7. `contract.noncanonical-bytes`
8. `contract.schema-invalid`
9. `contract.role-media-invalid`
10. `contract.ref-invalid`
11. `contract.digest-mismatch`
12. `contract.limit-exceeded`
13. `contract.closure-invalid`
14. `contract.signature-invalid`
15. `contract.authority-invalid`

Machine registry 必须冻结下列 operation phase vectors，按左→右返回第一个失败；不得按上面的 numeric id重排：

```text
parseArtifactBytes / parseControlBytes =
  input-too-large → utf8-invalid → bom-forbidden → json-syntax →
  duplicate-key → value-domain → noncanonical-bytes → schema-invalid

verifyRef =
  role-media-invalid → ref-invalid → limit-exceeded → fetch-exact →
  parseArtifactBytes phases → digest-mismatch

verifyClosure =
  root/child verifyRef → limit-exceeded → closure-invalid →
  signature-invalid → authority-invalid

verifyAuthorityEnvelope =
  envelope parse phases → role-media-invalid/ref-invalid → limit-exceeded →
  payload parse phases → digest-mismatch → signature-invalid → authority-invalid
```

`fetch-exact` 不是 error code；missing/truncated/extra bytes按 `ref-invalid`。JSON tokenizer 按 byte offset 左到右；只要全 document 有 syntax error就返回 `json-syntax`，只有语法完整时才报告 duplicate。Value-domain在 canonical re-encode前；noncanonical比 missing/unknown business field先。Role/ref/declared size必须在 fetch child前验证。`limit-exceeded` 专用于 declared child、embedded/closure byte/ref/node/depth checked-counter，不代替 root `input-too-large`或字段 `schema-invalid`。Closure DFS按 schema-defined field order、array index/digest order遍历；先完成 topology/named cardinality/cross-node equality，再验证 exact closure signature/trust，最后验证 authority pairing。因此 mixed closure + bad signature先 `closure-invalid`，valid closure + bad signature + bad authority先 `signature-invalid`。Signature具体原因在 production全部折叠为 `signature-invalid`，避免 oracle。

Operational admission 不混入上述 document phase。`CapabilityAdmissionErrorCodeV1` 是另一个 closed enum：`admission.production-fence-closed`、`admission.protected-store-unavailable`、`admission.state-stale-or-revoked`、`admission.deadline-not-live`、`admission.resource-unavailable`、`admission.replay`。Production entrypoint 必须在读取、解析或 fetch 调用端 payload **之前**先检查与 payload 无关的 local preconditions，顺序固定为 fence→protected-store health→minimum local resource availability；失败立即返回对应 code。只有 preflight 通过才运行 deterministic contract phases。Authenticated bytes验证完成后，state/epoch/revocation、deadline、nonce未消费和resource availability必须在**同一 serializable transaction**中重查，并原子提交 nonce consume + budget reservation + state transition；事务内失败报告优先级是 state→deadline→replay→resource，任何失败/race都不留 reservation。Pure parser/corpus API 永不返回 admission code；production endpoint 也不能为了找“更具体”的 document error 绕过前置 kill switch。

对同一 phase 的多个错误，选择最小 byte offset；无 byte offset 时选择 canonical field path UTF-8 bytes 最小者。TS/Rust 必须从同一 machine registry 生成两个 enum、phase/precondition map，并有 static drift test；corpus 的 multi-fault case 断言唯一首错 code，而不只断言“拒绝”。不在两个 enum 内的 internal exception 是实现缺陷，不能转成可继续的 unknown validation code。

### 19a.3 Domain separation、digest 与 detached signature

#### 19a.3.1 Digest types

V1 的五种 digest 形式为：

```text
RawContentDigestV1 = {
  kind: "raw-content", algorithm: "sha256", hex: lower_hex_64
}

ExternalDigestV1 = {
  kind: "external", namespace: ascii_identifier,
  algorithm: "sha256" | "sha512" | "git-sha1" | "git-sha256",
  value: lowercase_algorithm_hex
}

CanonicalPayloadDigestV1 = {
  kind: "canonical-payload", algorithm: "sha256",
  schemaRole: ClosedCanonicalRoleV1, hex: lower_hex_64
}

JournalDigestV1 = {
  kind: "catalog-journal-event", algorithm: "sha256",
  schemaRole: "catalog-event.v1", hex: lower_hex_64
}

SelfDevRunJournalDigestV1 = {
  kind: "selfdev-run-journal-event", algorithm: "sha256",
  schemaRole: "selfdev-run-journal-event.v1", hex: lower_hex_64
}
```

`RawContentDigestV1.hex = SHA-256(raw file bytes)`。External `sha256`/`git-sha256` 是 64 位 lowercase hex，`sha512` 是 128 位，`git-sha1` 是 40 位；`namespace` 是1..64 byte ASCII nominal identifier，且每个 containing field都由 registry冻结 exact namespace/algorithm allowlist，不能由 payload选择一个“格式合法”的任意 namespace。长度、字符或 field-specific algorithm/namespace policy 不匹配均拒绝。`ExternalDigestV1` 只标识外部系统中的输入，不能单独证明 artifact bytes；任何进入 catalog closure 的本地 bytes 仍须有 canonical 或 raw-content digest。

`JournalDigestV1.hex` 恰等于 `canonicalPayloadDigest("catalog-event.v1", exactCatalogEventCanonicalBytes).hex`；`SelfDevRunJournalDigestV1.hex` 恰等于 `canonicalPayloadDigest("selfdev-run-journal-event.v1", exactSelfDevRunJournalEventCanonicalBytes).hex`。两者 distinct `kind/schemaRole` 只防止 wire type confusion，不改变 §19a.3.2 preimage；它们与 `CanonicalPayloadDigestV1` 以及彼此均 nominally non-interchangeable。作为 predecessor 验证时变量就是 exact prior event bytes；verifier必须按对应 typed digest source fetch bytes、执行完整 canonical/schema/authority-envelope验证、重算该值并检查各自 sequence/run-or-capability chain，不能把 hex当成无需 bytes的可信 head。相同 payload bytes跨 Catalog/SelfDev domain、wrong kind/schemaRole/algorithm、uppercase/非64位 hex全部拒绝。

#### 19a.3.2 Canonical domain preimage

对 expected closed `schemaRole` 和 canonical payload bytes `C`：

```text
domainSeparatedBytes(schemaRole, C) =
  ASCII("plugin-kernel-contract\0v1\0")
  || ASCII(schemaRole)
  || 0x00
  || uint64_be(byte_length(C))
  || C

canonicalPayloadDigest(schemaRole, C) =
  lower_hex(SHA-256(domainSeparatedBytes(schemaRole, C)))
```

`schemaRole` 必须由调用端的 expected schema/endpoint 选择，不得由 payload 中的 `role`、signature envelope 中的 `signedSchemaRole` 或未验证的 ArtifactRef 决定。Length 是 `C` 的 byte length，不是 Unicode code point 数，且使用 8-byte unsigned big-endian。

`ClosedCanonicalRoleV1` 是 closed artifact schema roles、closed embedded/control roles、closed authority-only roles与 `ClosedContractMetaRoleV1={"registry-meta-schema.v1" | "capability-contract-registry.v1"}` 的不相交 tagged union；调用者不能传任意 string。两个 meta role只能用于 ABI bootstrap/build，不得进入 runtime/artifact/embedded/authority wire。`ArtifactRefV1` 的 `size` 是 canonical payload `C` 的长度，不包含 domain prefix。Digest 和 ArtifactRef 永远在被引用 bytes 之外计算；任何 node MUST NOT 包含自己的 digest、ArtifactRef 或签名。

#### 19a.3.3 Byte-level golden vector

下列向量只验证 canonical/domain/crypto primitive，不代替对上层业务 schema 的验证：

```text
schemaRole = permission-template.v1
C UTF-8    = {"effects":[],"version":1}
C length   = 26 (0x1a)
C hex      = 7b2265666665637473223a5b5d2c2276657273696f6e223a317d

preimage hex =
706c7567696e2d6b65726e656c2d636f6e747261637400763100
7065726d697373696f6e2d74656d706c6174652e763100
000000000000001a
7b2265666665637473223a5b5d2c2276657273696f6e223a317d

SHA-256 = fa6cf97e20476ac1e940fbf3b703054e86b92a9cd4ca149086f15ed9448adbf3

test-only Ed25519 seed =
9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60
public key = d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
signature over the preimage, base64url/no padding =
ckzMFq57Oq2025xUrn2BDeHkI0bnIFhzW9-UgIfsTdiBWDatELw1mZu7sAxFwn9dnIB0EBxE_rhuPTeGLRlMCQ
```

TS 和 Rust corpus MUST 对 `C`、完整 preimage、digest 和 test-only signature 做 byte-for-byte 断言，不得只比较解析后 object。测试 seed 只用于 corpus，MUST NOT 进入任何 production trust store。

#### 19a.3.4 Detached Ed25519

Bundle publisher signature 和 K0 authority signature 都使用 Ed25519，但 key purpose/trust root 分离，不得互用。签名输入是 verifier 根据 **expected role** 和已重读的 canonical payload独立构造的 `domainSeparatedBytes(expectedRole, C)`；不是 payload digest 的 UTF-8 hex，也不是 envelope 自报 role 构造的 bytes。

`SignatureEnvelopeV1` 只允许：

```text
{
  "algorithm": "ed25519",
  "keyId": <bounded ASCII key id>,
  "signatureBase64Url": <64-byte signature, RFC 4648 base64url without padding>,
  "signedArtifact": <exact BundleBinding ArtifactRefV1>,
  "signedSchemaRole": "bundle-binding-payload.v1",
  "version": 1
}
```

Ed25519 public key 是 32 bytes，signature 是 64 bytes；二者使用 RFC 4648 base64url，禁止 `=` padding、standard-base64 `+`/`/`、非最短编码和宽松解码。Verifier MUST 先用外部 expected role 构造 preimage，再检查 envelope 中的 role/ref 与已验证对象完全一致。

Crypto profile 名称固定为 **`ContractStrictPureEd25519V1`**，是 RFC 8032 PureEd25519 的 strict subset：context 为空，不使用 Ed25519ctx/Ed25519ph，不预哈希 message，不接受 library 的 ZIP-215/lax mode。Public key `A` 与 signature point `R` 必须是 canonical 32-byte compressed Edwards encodings（encoded `y < p` 且 decode→re-encode byte-equal）、在曲线上、非 identity/非 small-order，并满足 `[L]A=identity`、`[L]R=identity`；scalar `S` 是 little-endian integer 且 `0 ≤ S < L`。令 `h = little_endian_integer(SHA-512(R || A || M)) mod L`，验证等式恰为 `[S]B = R + [h]A`，不乘 cofactor，其中 `M` 是完整 domain-separated bytes。Hash-to-scalar 的 little-endian 解释不可替换为 big-endian。

ABI-00 adapter/dependency profile 也冻结：TS 使用 exact `@noble/curves@1.9.7`（lockfile integrity 必须锁定），先 canonical decode→re-encode、显式 non-identity/`isSmallOrder=false`/`isTorsionFree=true`、little-endian `S<L`，再以 `zip215:false` 并对上式做 adapter-level exact-equation check；Node/WebCrypto 单独验证不合格。Rust 使用 exact `ed25519-dalek@2.1.1`（direct `default-features=false, features=["std","zeroize"]`）和 `curve25519-dalek@4.1.3`（direct `default-features=false, features=["alloc","precomputed-tables","zeroize"]`）；Cargo resolved effective curve features必须恰含 `alloc,digest,precomputed-tables,zeroize`，并禁用 `legacy_compatibility,batch,hazmat`，Cargo.lock 还须锁定 resolved `sha2`/transitive checksums。在 `verify_strict` 外仍对 A/R 显式 canonical re-encode、non-identity、`is_small_order=false`、`is_torsion_free=true` 并执行同一 equation；`CompressedEdwardsY::decompress`/`VerifyingKey::from_bytes` 单独通过不合格。任何升级、feature/compile-flag变化都要新 corpus review，不得用“library 已 strict”替代这些步骤。

Trust-store ingestion 计算 `publicKeyFingerprint = SHA-256(raw 32-byte public key)`（internal nominal type，不进入 user display）。同一 fingerprint 在 publisher/authority/human trust registries、不同 keyId、keyPurpose 或 trust domain 中必须全局唯一；alias/cross-purpose reuse 一律拒绝，signer quorum/count 也按 fingerprint 去重而非按 keyId。`HumanKeyPurposeV1` closed enum恰为 `human-promotion-decision | human-adoption-decision | human-enable-decision | human-invocation-decision`，不得注册为 K0 authority/publisher purpose。Human signature也必须使用 `ContractStrictPureEd25519V1`，message是 caller-expected `human-decision.v1` 完整 canonical bytes的 role-separated preimage。每次 verify重新检查 registry uniqueness/revocation。Reject corpus必须覆盖 wrong length、noncanonical base64、`y ≥ p`、noncanonical R/A、identity/各 small-order point、非 prime-subgroup A/R、`S=L`/`S>L`、malleated S、prehash/context/cofactored-only/lax-valid signature、wrong expected role/domain/key purpose、同 key不同 id/purpose/domain/registry alias、K0 key冒充 human与 signer-count inflation。两种实现必须同收同拒。

`AuthorityEnvelopeV1` 使用同一编码和 expected-role 原则，但 authority payload 由 §19a.4 的通用 canonical-bytes container 携带，key 必须具有对应 `keyPurpose`。Signature field 从不决定 domain。

### 19a.4 CanonicalBytesContainerV1 与 EmbeddedCanonicalV1

Manifest subdocument 和 SelfDev plan 必须自证 bytes，但它们不是 ArtifactRef DAG node：

```text
CanonicalBytesContainerV1<R> = {
  "algorithm": "sha256",
  "bytesBase64Url": <canonical JSON bytes, base64url without padding>,
  "digest": <lowercase SHA-256 hex over role-separated bytes>,
  "role": R,
  "size": <decoded byte length>,
  "version": 1
}

EmbeddedCanonicalV1 =
  CanonicalBytesContainerV1<ClosedEmbeddedRoleV1>

AuthorityCanonicalPayloadV1 =
  CanonicalBytesContainerV1<ClosedAuthorityPayloadRoleV1>
```

Verifier MUST 使用外层字段/endpoint 的 expected role，严格 base64url decode，检查 decoded length，将 decoded bytes 按对应 strict schema parse/re-encode，再用 §19a.3 domain 重算 digest。`role`、`size`、`digest` 任一 mismatch 都拒绝。Container 的 digest 只在完成这些检查后计算。

Closed embedded roles 为：

- `capability-input-schema.v1`
- `capability-output-schema.v1`
- `permission-template.v1`
- `selfdev-promotion-plan.v1`
- `catalog-stage-effect-plan.v1`
- `git-promotion-effect-plan.v1`
- `permission-spec.v1`
- `effective-policy-snapshot.v1`
- `safe-display.v1`
- `safe-display-decision-mapping.v1`
- `catalog-permission-projection.v1`
- `sandbox-feature-requirements.v1`
- `host-bootstrap-profile.v1`
- `runtime-closure.v1`
- `persistent-host-probe.v1`
- `principal-descriptor.v1`
- `principal-binding.v1`
- `credential-binding.v1`
- `verification-environment.v1`
- `verification-command.v1`
- `selfdev-verification-context.v1`
- `selfdev-verification-bundle.v1`
- `selfdev-run-context.v1`
- `selfdev-approval-context.v1`
- `selfdev-run-transition-subject.v1`
- `participant-identity-set.v1`
- `acceptance-report.v1`
- `reviewer-isolation-attestation-set.v1`
- `known-limitations.v1`
- `rollback-target.v1`
- `human-participant-binding.v1`
- `human-decision.v1`
- `capability-revision-allocation-record.v1`
- `promotion-approval-consumption.v1`
- `secret-operand-binding.v1`
- `promotion-terminal-failure.v1`
- `reconciled-lineage-dependency.v1`
- `invocation-input.v1`
- `candidate-capability-output.v1`
- `capability-output-value.v1`
- `broker-target.v1`
- `broker-request.v1`

Embedded role 不是 Artifact `schemaRole`，不得塞进 `ArtifactRefV1`。`ClosedSignedArtifactSchemaRoleV1` 恰为本附录 closed pair 表中的六种 receipt role、`catalog-verification-endorsement.v1` 和 `catalog-event.v1`，且只允许 §19a.11 detached `ArtifactAuthorityEnvelopeV1`。`ClosedAuthorityPayloadRoleV1` 的唯一literal enum定义在§19a.11.1；本节不维护第二份别名清单。那些control-plane inline envelopes不是ArtifactRef DAG node。V1不允许自定义role或省略bytes/digest。

另有 bootstrap-only `registry-meta-schema.v1` 与 contract-internal `capability-contract-registry.v1` 两个 meta role，仅用于 §19a.13 bootstrap/registry/corpus digest，禁止出现在 Manifest embedded field、ArtifactRef、authority envelope或 runtime token。

Persistent artifact（Manifest/CEB/receipt）使用上面的完整 embedded bytes，确保离线 closure 可独立验证。短期 authority token 不复制大 sidecar，而使用：

```text
CanonicalObjectRefV1 = {
  "canonicalDigest": CanonicalPayloadDigestV1,
  "canonicalSize": <role-bounded decoded bytes>,
  "expiresAtMs": <not later than authority deadline>,
  "objectHandleId": <32 random bytes, base64url/no padding>,
  "readBudget": 1,
  "role": <registry-allowed canonical sidecar role>,
  "scopeId": <exact activation/invocation/effect id>,
  "scopeKind": "activation" | "invocation" | "effect",
  "sealed": true,
  "storeEpoch": <current protected-store epoch>,
  "version": 1
}
```

K0/Rust protected canonical-object store 接收 full canonical bytes，先按 expected role/limit完成 raw/canonical/schema/digest验证，再用 write-new + immutable seal 原子发布；handle 永不指向 host path/URL/fd，不能由 plugin 创建或枚举。Token issuer 只能绑定 store 返回的 ref。Rust verifier 按 signature lineage、scope/id/epoch/expiry/revocation重读 exact `canonicalSize` bytes，重算 typed digest，并以 CAS 将 `readBudget:1→0`；胜者可把 verified bytes保留在该 invocation 的 K0 内存上下文，输家/换 handle/digest/size/role/epoch/TOCTOU identity 全拒绝。Ref 或 digest 单独不构成 authority。

`CanonicalObjectRefV1` role/scope allowlist closed：activation只允许principal/profile/probe；invocation只允许principal/input/template/spec/SafeDisplay/mapping/effective-policy/decision-proof、`reconciled-lineage-dependency.v1`与`secret-operand-binding.v1`；effect只允许broker-target/request。Artifact/meta/receipt/event不得放ref。Issuer/verifier必须reload exact bytes；operational K0 owns seal/readBudget CAS，contract package只pure verify supplied bytes。

`CanonicalObjectRefV1.readBudget=1` 只约束某个 envelope 的 sidecar bytes，不能作为 parent authority 的多子调用 ledger。Activation 通常产生多个 Invocation，Invocation 又产生多个 Broker effect，因此 K0/Rust 另维护：

```text
AuthorityContextRefV1 = {
  "contextHandleId": <32 random bytes, base64url/no padding>,
  "contextKind": "activation" | "invocation",
  "expiresAtMs": <parent deadline>,
  "parentPayloadCanonicalDigest": CanonicalPayloadDigestV1(
    role="activation-token-payload.v1" | "invocation-grant-payload.v1"
  ),
  "scopeId": <activationId | invocationId>,
  "storeEpoch": <authority-ledger epoch>,
  "version": 1
}
```

Parent envelope successful single-use admission在同一 serializable transaction中创建 immutable verified-parent record和 mutable remaining-budget/context state。Record 保存 exact parent payload/envelope bytes或不可变 protected pointer、issuer key fingerprint、CEB/CAB/receipt/head/epoch lineage、principal identity和 initial budget；context state closed lifecycle 是 `ACTIVE → EXHAUSTED | EXPIRED | REVOKED | CLOSED`。InvocationGrant 必须同时绑定 activation context ref + exact activation payload typed digest；BrokerCallToken 必须同时绑定 invocation context ref + exact invocation-grant typed digest。Child verifier要求 signed child token、context lookup、stored parent bytes/digest/signature/lineage和 current state全部匹配；digest、context handle或 parent envelope任一单独都不构成 authority。

Activation context 可以经 atomic budget reservation签发多个 invocation，Invocation context可以签发多个具体 effect token；每次 child issue/consume都在 ledger CAS 中扣减 exact resource/effect ordinal，不复用 parent nonce。某 envelope 的 `CanonicalObjectRefV1` handle绝不能被另一个 parent/child envelope复用：相同 canonical bytes也必须按 child scope重新 seal并生成新 handle/read budget。Context crash/recovery、epoch rollback、missing parent envelope或 remaining-budget不明都 fail closed；context ref无 host path、不可枚举、不可由 plugin伪造。

### 19a.5 Closed artifact roles

#### 19a.5.1 ArtifactRefV1

```text
ArtifactRefV1 = {
  "digest": <lower_hex_64>,
  "digestAlgorithm": "sha256",
  "mediaRole": <ClosedMediaRoleV1>,
  "schemaRole": <ClosedArtifactSchemaRoleV1>,
  "size": <non-negative safe integer>,
  "version": 1
}
```

`ArtifactRefV1` 是 Artifact DAG edge 的唯一 wire reference representation；`schemaRole` 已参与 digest domain。其他 typed canonical digest/container不是 DAG ref。引用方必须通过具名字段（如 `manifestRef`）携带，不得使用无语义的 `upstreams: ArtifactRef[]`。

#### 19a.5.2 Closed media/schema pair allowlist

| `mediaRole` | 唯一允许的 `schemaRole` |
|---|---|
| `canonical-json` | `source-input-set.v1`, `build-input-set.v1`, `file-manifest-payload.v1`, `manifest-payload.v2`, `bundle-binding-payload.v1`, `catalog-evidence-binding.v1`, `catalog-adoption-binding.v1` |
| `signature-envelope` | `signature-envelope.v1` |
| `attestation` | `evidence-set.v1`, `provenance-attestation.v1`, `sbom-attestation.v1` |
| `endorsement` | `catalog-verification-endorsement.v1` |
| `receipt` | `promotion-approval-receipt.v1`, `catalog-stage-receipt.v1`, `git-promotion-receipt.v1`, `selfdev-completion-receipt.v1`, `adoption-approval-receipt.v1`, `enable-approval-receipt.v1` |
| `catalog-event` | `catalog-event.v1` |

上表是全部 allowlist，不是示例。Unknown media/schema role、合法 role 的非法 pair、case-folded alias、未知 version 或同一 bytes 被改 role 重放都必须拒绝。

#### 19a.5.3 Rank 和具名上游基数

ArtifactRef DAG 中的 rank 固定为：

```text
0  source-input-set / build-input-set / file-manifest-payload
1  manifest-payload
2  bundle-binding-payload
3  signature-envelope
4  evidence-set / provenance-attestation / sbom-attestation
5  catalog-verification-endorsement
6  catalog-evidence-binding
7  promotion-approval-receipt
8  catalog-stage-receipt / git-promotion-receipt
9  selfdev-completion-receipt
10 catalog-adoption-binding
11 adoption-approval-receipt
12 enable-approval-receipt
13 catalog-event
```

每个 ArtifactRef edge MUST 从高 rank 指向低 rank。Verifier 同时必须使用 `visiting`/`verified` set；不得仅因 rank 表“理论上无环”而省略实际 cycle/self-ref 检查。Catalog journal 的 predecessor 使用独立 `JournalDigestV1`，不是 ArtifactRef；它另外要求 sequence 严格减小和 visiting-set 检查。

| Node | 具名 upstream 字段与精确基数 | 额外一致性 |
|---|---|---|
| `SourceInputSetV1` | 无 ArtifactRef | 只含受限 `ExternalDigestV1` source/base entries |
| `BuildInputSetV1` | 无 ArtifactRef | 只含受限 `ExternalDigestV1` recipe/toolchain/runtime entries |
| `FileManifestPayloadV1` | 无 ArtifactRef | 只含 payload regular-file entries |
| `ManifestPayloadV2` | `fileManifestRef`: exactly 1 | 必须为 `file-manifest-payload.v1` |
| `BundleBindingPayloadV1` | `sourceInputSetRef`: 1; `buildInputSetRef`: 1; `fileManifestRef`: 1; `manifestRef`: 1 | `manifestRef.fileManifestRef` 必须 byte-equal 于本 node 的 `fileManifestRef` |
| `SignatureEnvelopeV1` | `signedArtifact`: exactly 1 | 必须是同一 `bundle-binding-payload.v1` |
| `EvidenceSetV1` | `bundleBindingRef`: 1; `signatureRefs`: 1..16 | 所有 signature 签同一 binding，keyId 不重复 |
| `ProvenanceAttestationV1` | `sourceInputSetRef`: 1; `buildInputSetRef`: 1; `fileManifestRef`: 1; `bundleBindingRef`: 1; `signatureRefs`: 1..16 | source/build/files 必须等于 binding closure |
| `SbomAttestationV1` | `fileManifestRef`: 1; `bundleBindingRef`: 1; `signatureRefs`: 1..16 | 每个 SBOM file/component 必须能映射到同一 FileManifest |
| `CatalogVerificationEndorsementV1` | `bundleBindingRef`: 1; `priorBundleBindingRef`: 0..1; `signatureRefs`: 1..16; `evidenceSetRef`: 1; `provenanceRef`: 1; `sbomRef`: 1; K3 `selfDevPromotionPlan.bundleBindingRef`: 1，K1/K2: 0 | K0 catalog verifier authority覆盖 exact outputs、participants、acceptance、limitations/rollback；唯一 nested ref必须 byte-equal顶层 binding |
| `CatalogEvidenceBindingV1` | `bundleBindingRef`: 1; `signatureRefs`: 1..16; `evidenceSetRef`: 1; `provenanceRef`: 1; `sbomRef`: 1; `catalogVerificationEndorsementRef`: 1; K3 `selfDevPromotionPlan.bundleBindingRef`: 1，K1/K2: 0 | 三个 output、endorsement与 copied plan必须共享 exact binding、outputs与 exact ordered publisher signature set |
| `PromotionApprovalReceiptV1` | `catalogEvidenceBindingRef`: exactly 1 | 只批准 CEB，不批准 raw bundle/evidence/plan |
| `CatalogStageReceiptV1` | `catalogEvidenceBindingRef`: 1; `promotionApprovalReceiptRef`: 1 | 绑定同一 plan/reservation/fence |
| `GitPromotionReceiptV1` | `catalogEvidenceBindingRef`: 1; `promotionApprovalReceiptRef`: 1 | 绑定同一 plan/reservation/fence |
| `SelfDevCompletionReceiptV1` | `catalogEvidenceBindingRef`: 1; `promotionApprovalReceiptRef`: 1; `catalogStageReceiptRef`: 1; `gitPromotionReceiptRef`: 1 | 四条 lineage 的 CEB/plan/approval/reservation/fence 必须全相同 |
| `CatalogAdoptionBindingV1` | `catalogEvidenceBindingRef`: 1; K3 时 `selfDevCompletionReceiptRef`: 1，K1/K2 时必须缺省 | 包含新 `targetInstallationDomain`，不改 origin/source trust |
| `AdoptionApprovalReceiptV1` | `catalogAdoptionBindingRef`: 1; nested `observedActivationSlotHead.activeCatalogAdoptionBindingRef`: 0..1; nested `observedActivationSlotHead.activeCatalogEvidenceBindingRef`: 0..1 | slot 两个 active refs 必须同 null或同 present并形成 exact CAB→CEB；不得引用/复用 promotion approval |
| `EnableApprovalReceiptV1` | `catalogAdoptionBindingRef`: 1; `adoptionApprovalReceiptRef`: 1; nested `expectedInstallationRecordHead.catalogAdoptionBindingRef`: 1; nested `expectedActivationSlotHead.activeCatalogAdoptionBindingRef`: 0..1; nested `expectedActivationSlotHead.activeCatalogEvidenceBindingRef`: 0..1; nested `hostBootstrapProfile.buildInputSetRef`: 1; nested `hostBootstrapProfile.bundleBindingRef`: 1; nested `hostBootstrapProfile.fileManifestRef`: 1 | expected record CAB必须 byte-equal顶层 CAB；slot pair必须 exact CAB→CEB current state；三个 profile refs必须等于 target CAB→CEB→Binding closure；`persistentHostProbe` 不含 ArtifactRef |
| `CatalogEventV1` | transition-specific direct refs + 每个 inline expected Head/result Projection 中 §19a.9.2 closed head-ref paths 的 actual 0/1 occurrences | 每个 union分支的 direct/head/projection path全部由 registry枚举、计 closure且与 current store/top-level target field-equal；event 不得被任何上述 artifact 反向引用 |

`signatureRefs` MUST 按 ArtifactRef digest bytes 升序，各 node 的列表必须 byte-for-byte 一致。“有一组都能验证的签名”不足以通过；必须是 CEB 冻结的 **same signature set**。

### 19a.6 Root payload contracts

所有 root 都必须含 `version: 1`；schema role 来自调用端 expected role 和 ArtifactRef，而不是 payload 自报的通用 `schemaRole` 字段。本节列出业务字段，不表示可增加 unknown fields。Identifier 统一为 1..128 bytes ASCII，匹配 `[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?`；`trustDomain`、`targetInstallationDomain`、`principalId`、`capabilityId`、`contributionId` 是不同 nominal type，不可互换。

`TargetTripleV1` closed enum 恰为 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`aarch64-unknown-linux-gnu`、`x86_64-unknown-linux-gnu`、`aarch64-unknown-linux-musl`、`x86_64-unknown-linux-musl`、`aarch64-pc-windows-msvc`、`x86_64-pc-windows-msvc`。出现在 contract enum 不等于 platform 可 activation；current probe/policy 仍可并且对未交付 Windows persistent host 必须返回 unavailable。

随机/去重字段是 closed nominal types，全部 strict RFC 4648 base64url/no-padding且不得互换：`ActivationNonceV1`、`InvocationGrantNonceV1`、`BrokerCallNonceV1` 各为 **16 random bytes**；`DecisionNonceV1`、`HumanChallengeNonceV1`、`IdempotencyKeyV1` 各为 **32 random bytes**。`ChallengeIdV1`、activation/invocation/effect id 与 `EffectAttemptIdV1` 是各自 1..128 byte ASCII identifier，匹配本节 identifier grammar且不是 nonce；attempt id只能由protected effect ledger allocator产生，并在同一effect lineage内unique。Decoded length、field-specific nominal type或 lineage不匹配均拒绝；即使 bytes偶然相同也不能跨类型/parent复用。`policyEpoch`、`trustEpoch`、`revocationEpoch`、catalog sequence和capability revision是非负 safe integer。`CapabilityReservationFenceV1`与`RunWorkerFenceV1`也各自是wire上的非负 safe integer nominal type，但前者只由per-capability promotion-fence allocator递增，后者只由§18 per-run lease allocator递增；两者在TS/Rust中不得互赋、比较或以相同serializer API代入。Sequence/revision/fence的下一值一律checked-add 1并按各自 reducer 单调增加，overflow拒绝。所有 `{issuedAtMs, notBeforeMs?, expiresAtMs}` 必须满足 `issuedAtMs ≤ notBeforeMs ≤ expiresAtMs`（无 `notBeforeMs` 时按 issuedAt），且 duration 不超过对应 K0 policy ceiling。

#### 19a.6.1 Input sets

`SourceInputSetV1` 包含 `sourceSetId`、`producerId`、`baseRevision: ExternalDigestV1`、K3 branch required 的 canonical full `baseRef`（K1/K2 closed branch为 `null`），以及按 `logicalName` UTF-8 bytes 排序的 `sources[]`；每项只含 `logicalName`、`sourceKind`（`git-tree | archive | generated-source | local-import`）和 `externalDigest: ExternalDigestV1`。`sources` 最多 4,096 项，logical name 唯一。K3 的 `baseRevision` field contract固定 `namespace="git-object"`，algorithm由 repository object format唯一映射，且 `baseRef`/`baseRevision` 必须与 §19a.8 verification/plan/Git transaction逐字相同；K1/K2 不能借 nullable field自报 Git authority。

`BuildInputSetV1` 包含 `buildSetId`、`recipeExternalDigest: ExternalDigestV1`、`toolchains:ToolchainInputV1[]`、`runtimeInputs:RuntimeInputV1[]`、`executables:ExecutableBindingV1[]`，以及 `runtimeClosure: EmbeddedCanonicalV1(role="runtime-closure.v1")`。`ToolchainInputV1` exact shape为`{externalDigest:ExternalDigestV1,logicalName,target:TargetTripleV1,version:1}`；`RuntimeInputV1` exact shape为`{externalDigest:ExternalDigestV1,logicalName,target:TargetTripleV1,version:1}`。两数组各最多 **256** 项，均按`(logicalName,target)` unsigned ASCII bytes排序且组合unique；同一pair跨数组不等价，unknown/duplicate/unsorted拒绝。

`runtime-closure.v1` exact root是`{entries:RuntimeClosureEntryV1[],version:1}`；`RuntimeClosureEntryV1={contentDigest:RawContentDigestV1,logicalPath,modeClass:"data"|"executable",size,target:TargetTripleV1,type:"regular-file",version:1}`。`logicalPath`使用§19a.6.2同一portable relative ASCII path grammar、segment/prefix/case-fold uniqueness和no-symlink规则；entries按`(target,logicalPath)`排序unique，最多 **1,024** 项，且每个target只能包含该target可重建的最小runtime集合，禁止broad system root。Generator必须以所有mandatory fields构造1024-item/1025-reject且证明512 KiB child/1 MiB parent边界可达。

`ExecutableBindingV1` exact inline record是 `{contentDigest:RawContentDigestV1,executableLogicalId,modeClass:"executable",runtimeClosurePath,size,target:TargetTripleV1,toolchainExternalDigest:ExternalDigestV1,version:1}`。`executables` 最多 **128** 项，按 `(target,executableLogicalId)` 排序且组合唯一；每项必须映射到runtime closure exactly one record，并要求`runtimeClosurePath==logicalPath`以及`contentDigest,size,target,modeClass="executable"`逐字段相等；`toolchainExternalDigest`必须等于同target唯一selected ToolchainInput record。Binding无host path/PATH/alias/optional digest。Process target只能复制完整binding。Registry必须构造128-item fully-valid recipe及129th cardinality reject，并分别覆盖512 KiB/1 MiB byte boundary。

External source 是构建输入声明，不是 artifact closure 的替代品。Trusted builder 必须读取这两个 input set 并产生 FileManifest/Manifest；BundleBinding 是第一个同时绑定 input sets 与 outputs 的 node。

#### 19a.6.2 FileManifestPayloadV1

FileManifest 是 **payload-only**：

```text
{
  "entries": [
    {
      "contentDigest": RawContentDigestV1,
      "modeClass": "data" | "executable",
      "path": <portable relative path>,
      "size": <raw file byte length>,
      "type": "regular-file"
    }
  ],
  "entrypoint": <one path present in entries>,
  "version": 1
}
```

硬规则：

- `entries` 最多 **65,536** 项，按 `path` UTF-8 bytes 严格升序，path 不重复。一个 file path 不得是另一个 file path 的 segment-prefix。
- Path 使用 `portable-ascii-bundle-path.v1`：1..1,024 ASCII bytes 的相对 POSIX form，使用 `/`，每 segment 1..255 bytes 且只匹配 `[A-Za-z0-9._@+-]+`。禁止空 segment、`.`、`..`、leading/trailing slash、backslash、colon、segment trailing dot，以及 basename（第一个 `.` 前）ASCII-case-insensitive 等于 `CON/PRN/AUX/NUL/COM1..COM9/LPT1..LPT9`。完整 path 按 ASCII lowercase fold 后不得重复；因此 V1 不执行 Unicode normalization/case-fold。
- 只允许 regular file。Symlink、hardlink（相同 file identity/inode 或 link count > 1）、directory entry、device、FIFO、socket 和 reparse-point alias 全部拒绝。目录只由 file path 隐式推导，不进 entries。
- `modeClass=data` 对应归一化 `0644`，`executable` 对应 `0755`。uid/gid/timestamp/xattr/ACL 不进 payload，也不得被用来改变执行语义。
- Verifier 在 sealed root 下使用 no-follow/openat-style 语义重读每个 file，检查 type/identity/size/content digest，并证明实际 regular files 与 entries 是精确全集。Partial list、额外 file、TOCTOU identity change 或 entrypoint 不在集合中都拒绝。
- FileManifest 不得出现 source/build input、Manifest/Binding ref、signature、origin/trust/lifecycle、provenance/SBOM/evidence、approval/effect/completion receipt、Catalog metadata/event 或自己的 digest/ref。

`FilesystemPolicyBindingV1` 是 closed inline object：

```text
{
  "logicalPolicyId": "portable-ascii-bundle-path",
  "logicalPolicyVersion": 1,
  "target": TargetTripleV1,
  "targetGuardPolicyId":
    "darwin-file-identity-guard" |
    "linux-file-identity-guard" |
    "windows-file-identity-guard",
  "targetGuardPolicyVersion": 1,
  "version": 1
}
```

Closed mapping 为 Apple targets→`darwin-file-identity-guard`，GNU/musl Linux targets→`linux-file-identity-guard`，Windows MSVC targets→`windows-file-identity-guard`；Manifest 只能声明排序且不重复的 `targetTriples`，不能选择/覆盖 policy id/version。BundleBinding 必须含由 K0 根据该表派生、按 target 排序的 exact `filesystemPolicyBindings`，数量与 Manifest targets 相等。HostBootstrapProfile 与 verification environment/persistent-host probe 必须各绑定当前 target 的同一 policy object。

Target guard 必须在 sealed root 上证明 actual filesystem lookup/file identity 不会把两个 logical paths alias，且 no-follow、regular-file、hardlink/reparse 和全量枚举规则都成立；实际 filesystem 无法证明“不比 logical policy 更宽松”时，该 target unavailable。Policy object 是固定 closed bytes，不使用调用端提供的裸 policy digest；Binding/Profile/Evidence 的 canonical digest 会分别覆盖相同 bytes。

#### 19a.6.3 ManifestPayloadV2 与 contribution subdocuments

Manifest 包含 `manifestVersion: 2`、`capabilityId`、`capabilityVersion`、`fileManifestRef`、`entrypoint`、1..8 个排序且不重复的 `targetTriples: TargetTripleV1[]`、`minSandboxFeatures`、`resourceEnvelope` 和 1..32 个按 `contributionId` 排序的 `contributions[]`。`capabilityVersion` 是1..64 ASCII canonical SemVer 2.0.0，无prefix/range/floating rewrite。Normal upgrade必须strictly超过历史watermark；同一full version永久只绑定同一BundleBinding，build metadata不提高precedence。Rollback用fresh authority与更大capabilityRevision且不降低watermark。Manifest不自报filesystem policy/origin/trust/lifecycle。

Cross-node target invariant `MANIFEST-RUNTIME-TARGET-V1`：Manifest `entrypoint` 必须与 referenced FileManifest `entrypoint` byte-equal、存在且满足 executable mode policy；Manifest `targetTriples`、BuildInputSet runtimeClosure/toolchain 的 complete target set、BundleBinding `filesystemPolicyBindings` target set必须 exact set equality（无缺/多/duplicate）。每个 target必须有可闭合的 runtime files + exact toolchain identity；Evidence environment、HostBootstrapProfile和PersistentHostProbe只能选择该集合成员并复用对应 policy object byte-equal。Launcher不能另选 entrypoint/target，任何 signed Binding仍缺 runtime closure的 target都不可用且 verifier拒绝。

`minSandboxFeatures` 是最多 32 项、按 closed feature id 排序且无重复的 array。V1 feature ids 恰为 `fixed-bootstrap`、`physical-no-network`、`minimal-ro-closure`、`private-data`、`scratch`、`single-ipc`、`env-clear`、`wall-limit`、`cpu-limit`、`rss-limit`、`pid-limit`、`fd-limit`、`output-limit`、`rpc-limit`、`tree-kill-reap`、`activation-token-validation`、`invocation-grant-validation`、`broker-token-validation`、`rust-workspace-fs-broker`、`rust-http-broker`、`rust-process-broker`、`logical-token-ledger`。`ResourceEnvelopeV1` 使用 §19a.11 的全部 closed budget keys，并给出每项申请上限；不用的资源必须显式写 0，missing/unknown key 都拒绝。K0 policy 只可收窄这两个声明，不能扩大。

`capability-input-schema.v1` / `capability-output-schema.v1` 使用 closed `CapabilityValueSchemaV1`，不是开放 JSON Schema。Control values 只允许 `null/boolean/safe-integer/control-string/array/object/enum`；control-string 使用 §19a.2 的无 control/bidi canonical string。为使 Write/Edit/code/prompt 与 binary capability 可插件化，data values 另有 `utf8-text`、`sealed-blob-ref`、`secret-handle-ref` 三个 closed type，不能伪装成 control-string。

`CapabilityValueSchemaV1` 的 exact tagged union如下；每个 variant只允许列出的 fields且每个 nested schema也必须有 `version:1`：

```text
{"kind":"null","version":1}
{"kind":"boolean","version":1}
{"kind":"safe-integer","maximum":<safe int>,"minimum":<safe int>,"version":1}
{"kind":"control-string","maxUtf8Bytes":<0..16384>,"minUtf8Bytes":<0..max>,"version":1}
{"kind":"enum","valueKind":"boolean"|"safe-integer"|"control-string",
 "values":[<native scalar>...],"version":1}
{"kind":"array","items":CapabilityValueSchemaV1,
 "maxItems":<0..4096>,"minItems":<0..max>,"version":1}
{"additionalProperties":false,"kind":"object",
 "properties":[{"name":<SchemaFieldNameV1>,"schema":CapabilityValueSchemaV1}...],
 "required":[<SchemaFieldNameV1>...],"version":1}
{"kind":"utf8-text","maxBytes":<0..32768>,"minBytes":<0..max>,"version":1}
{"allowedMediaTypes":<sorted nonempty subset of ["binary","diff","json-text","utf8-text"]>,
 "kind":"sealed-blob-ref","maxBytes":<0..67108864>,"minBytes":<0..max>,"version":1}
{"allowedScopes":[<SecretScopeIdV1>...],
 "allowedSecretKinds":<sorted nonempty subset of ["api-token","generic-credential",
   "oauth-token","signing-key","ssh-private-key"]>,
 "kind":"secret-handle-ref","version":1}
```

Integer要求 `minimum≤maximum`。Enum 有1..256个、按 scalar type tag + Canonical JSON bytes严格升序且无 duplicate；boolean enum最多2。`valueKind="control-string"` 的每个 member仍必须满足 control-string value domain且 UTF-8 byte length ≤ **16,384**，enum不能绕过单值上限；该上限是 variant 固定常量，不允许 member-specific隐式放宽。Object properties 0..256项，name为1..64 ASCII bytes并匹配 `[a-z][a-z0-9_-]*`，按 name bytes排序；`required` 同序、无重复且必须是 properties子集。`additionalProperties` 必须 literal false。Allowed media/kind/scope arrays各1..32项，按 ASCII bytes排序且无重复；scope是1..128-byte typed ASCII id。Schema tree nesting depth最多32、node总数最多4,096、所有 property/enum/allowed-list item occurrences合计最多16,384；checked counter在递归分配前执行。Input schema可用全部 variants；output schema禁止 `secret-handle-ref`，且 output blob/text只有 K0 secret gate mint的 wire value才合法。Shared corpus必须提供一个 exactly 16,384-byte control-string enum member的 fully-valid case和 16,385-byte member的 `contract.schema-invalid` one-over case，并分别覆盖 schema parse与 value validation。

Value validator完全由 schema direction决定：null/boolean/integer/control-string使用 native JSON scalar；array按 items递归且 item count在区间；object必须含 exactly required + any declared optional keys、拒绝 unknown，并按 Canonical JSON key order；enum要求 scalar type和值 byte-equal。`utf8-text`、`sealed-blob-ref`、`secret-handle-ref` 分别只接受下述 exact wire object，不能被普通 object schema“结构碰巧相同”而提升权限。`invocation-input.v1` exact root是 `{contributionId,inputSchemaCanonicalDigest:CanonicalPayloadDigestV1(role="capability-input-schema.v1"),value,version:1}`；K0-final `capability-output-value.v1` exact root是 `{contributionId,outputSchemaCanonicalDigest:CanonicalPayloadDigestV1(role="capability-output-schema.v1"),value,version:1}`。Verifier必须从 Manifest embedded schema bytes重算 typed digest、按 direction验证 value，再创建 protected object；caller不能提交 schema或 direction。

Plugin handler不能伪造 K0-minted `classification`/digest。它的唯一 outbound frame role是 `candidate-capability-output.v1`，exact root为 `{contributionId,outputSchemaCanonicalDigest:CanonicalPayloadDigestV1(role="capability-output-schema.v1"),value,version:1}`；control scalars/arrays/objects沿 output schema，但 inline text leaf必须是 `{bytesBase64Url,encoding:"utf-8",kind:"utf8-text-candidate",size,version:1}`，无 classification/digest，strict base64 decode后≤32 KiB且 size重算；blob leaf只能是先经 `sealed-blob:create-output` broker完成 guard/seal后返回的 `SealedBlobRefV1`。K0先按 output schema解析 candidate、对每个 inline leaf执行 secret guard，再把通过的 leaf确定性转换成 `Utf8TextV1`并 mint final `capability-output-value.v1` protected object。Plugin frame含 final `Utf8TextV1`、caller digest/classification、raw multiline JSON string、未 sealed blob或 unknown leaf均拒绝。命中/疑似 secret 的 output一律 DESTROY并返回 closed `secret-output-blocked` result，**不得**转换成 `SecretHandleRefV1`；secret handle只作为 K0提供的 inbound value或 broker-internal credential path存在。

`Utf8TextV1` wire value 是 `{version:1, classification:"nonsecret-untrusted", encoding:"utf-8", bytesBase64Url, size, contentDigest:RawContentDigestV1}`。Decoded bytes 最多 **32 KiB**、必须是 valid UTF-8，但作为 opaque untrusted content 可包含 LF/TAB/CR、其他 control、bidi、任意 normalization form 或 BOM；parser 不把 decoded text 重新塞进 JSON string，不 normalize，并重算 size/raw digest。Base64url 必须 strict/no-padding，因此 canonical JSON 本身仍只含无 control ASCII。`classification` 只能由 K0 mint，不能由 plugin/input object 自报；所有 inbound/outbound inline text 必须先经下述 secret guard。标记、命中或 uncertain 的 bytes 不能产生 plugin-visible inline bytes/raw digest。

更大 text 或任何 binary 使用 `SealedBlobRefV1`：

```text
{
  "blobId": <32 random bytes, base64url/no padding>,
  "classification": "nonsecret-untrusted",
  "blobMediaType": "utf8-text" | "binary" | "diff" | "json-text",
  "contentDigest": RawContentDigestV1,
  "expiresAtMs": <bounded by invocation/activation>,
  "invocationId": <exact lineage>,
  "sealed": true,
  "size": <bounded by schema and resource budget>,
  "storeEpoch": <current K0 blob-store epoch>,
  "version": 1
}
```

`SealedBlobRefV1` 只解析到 K0/Rust-owned ephemeral sealed blob store；无 host path、URL、fd 或 reusable handle，digest/ref 本身不授予读取权。Blob lifecycle 是 closed state machine `WRITING_QUARANTINED → SEALED_NONSECRET → EXPIRED | REVOKED | DESTROYED`：writer 先写未发布临时对象，plugin不能写 `classification`。K0 secret guard用 version-pinned scanner在 bounded stream上检查完整 bytes；只有 protected ledger中 purpose-scoped signed `NONSECRET` verdict与 exact object identity/size/raw digest/scanner version byte-equal，seal operation才可 write-once mint `classification:"nonsecret-untrusted"` 的 ref。命中 secret或 `UNKNOWN/INCONCLUSIVE` 时，outbound object必须 DESTROY并返回 `secret-output-blocked`；只有 K0-originated inbound secret ingestion在 policy明确允许时可直接 mint `SecretHandleRefV1`，plugin永远拿不到该 secret bytes的 raw digest/blob ref。Inline Utf8Text publish也走同一 verdict，不存在“小文本绕过”。SEALED 后禁止 reopen-for-write、append、rename-replace或identity change。Rust broker每次 stream open都重验 store epoch/scope/invocation/expiry/state/identity/digest/size和 classification ledger，并与 exact single-use BrokerCallToken做 CAS；TOCTOU、crash后 verdict/seal freshness不明、partial read或 budget overflow都撤销该 ref。未 seal/失败/到期的 output必须删除，SEALED input到 scope结束后回收。

Permission derivation 对 data carrier 使用 closed metadata allowlist：`Utf8TextV1` 只能选择 `encoding/contentDigest/size`，`SealedBlobRefV1` 只能选择 `blobMediaType/contentDigest/size`，`SecretHandleRefV1` 只能选择 `scope/secretKind`。Template/PermissionSpec/SafeDisplay/target/argv/DNS/authority payload **MUST NOT** select `bytesBase64Url`、`blobId`、`handleId` 或任何 decoded bytes；这些字段也不能参与 concat/map/condition。Content digest/size 只可用于绑定 exact nonsecret content/budget，不可转换成 path、command、host 或 credential authority。InvocationGrant 通过后，inline text 才可随 bounded handler frame发送；blob content 只能用 exact grant 下的 `sealed-blob:read-input` BrokerCallToken 读取/流式传输，large output 用 `sealed-blob:create-output`。Workspace-fs write token 必须另绑定实际 nonsecret content `RawContentDigestV1`/size，防止 handler 换内容。Blob expiry/revocation/budget/lineage mismatch、digest mismatch 或 replay 一律拒绝并删除未完成 output。

`SealedBlobRefV1` 只允许已由 K0 secret guard 标为 `nonsecret-untrusted` 的内容。Raw SHA-256 对低熵 secret 可能形成离线猜测 oracle，因此命中 secret policy 的 bytes MUST NOT 产生 plugin-visible blob ref/content digest，而要变成：

```text
SecretHandleRefV1 = {
  "expiresAtMs": <bounded deadline>,
  "handleId": <32 random bytes, base64url/no padding>,
  "invocationId": <exact lineage>,
  "scope": <closed credential/secret scope>,
  "secretKind": <closed nonsecret kind label>,
  "storeEpoch": <current secret-store epoch>,
  "version": 1
}
```

SecretHandle 不含 raw bytes、raw/content digest、长度或可逆 metadata，只有 K0 credential/secret broker 能解析。Plugin只能在 exact PermissionSpec/InvocationGrant下把 handle提交到两个 closed slots：`credential-sign.secretHandleRef`，或 scope精确绑定 scheme/dns/port/method 的 `http.credentialHandleRef`；后者只能由 HTTP broker内部解析并注入 auth，不能读取/回传 secret。SafeDisplay使用 §19a.10 的 HMAC display fingerprint，log/evidence默认只记 operation/scope，不记 handle id。Secret handle的 scope/TTL/revocation/nonce与单次 BrokerCallToken原子消费；其他 broker slot、redirect继承、classification不确定、store unavailable或跨 invocation replay都 deny。

String/array/object/text/blob schema 必须给出 byte/item/property 上限；object 以排序的 `properties[]` + `required[]` 表达且 `additionalProperties=false`；array 必须有单一 `items` schema 和 `maxItems`。V1 禁止 `$ref`、recursive schema、regex/pattern、format plugin、default/coercion、`oneOf/anyOf/allOf`、executable validator 和 unknown keyword。Schema 自身 depth 以及它允许的 value depth 都不得超过 32。

每个 contribution 必须内嵌：

```text
{
  "activationScope": "process" | "session" | "turn",
  "concurrency": <closed bounded contract>,
  "contributionId": <typed id>,
  "effectsDeclared": <sorted closed broker/operation pairs>,
  "inputSchema": EmbeddedCanonicalV1(role="capability-input-schema.v1"),
  "kind": <closed capability surface from §19.1.1>,
  "outputSchema": EmbeddedCanonicalV1(role="capability-output-schema.v1"),
  "permissionTemplate": EmbeddedCanonicalV1(role="permission-template.v1"),
  "resourceClass": <closed resource class>,
  "resultTrust": "untrusted",
  "version": 1
}
```

`kind` 的 closed enum 恰为 `tool`、`provider`、`router-policy`、`prompt-source`、`hook`、`command`、`memory-adapter`、`skill-source`、`subagent-profile`、`context-policy`、`evaluator`、`ui-surface`、`protocol-adapter`、`observability-sink`。其中 `hook` 只允许 observational/transform；mandatory security hook 不是 contribution。

`resourceClass` closed enum 恰为 `pure | interactive | streaming | batch`。`concurrency` 是 `{maxInFlight, reentrant, ordering}` 的 closed object：`maxInFlight` 为 1..64 safe integer，`reentrant` 为 boolean，`ordering` 只能 `serial | input-order | unordered`；组合不被 capability kind policy 支持时拒绝。

`effectsDeclared` 的 closed broker/operation pairs 恰为：workspace-fs=`read-file | list-directory | write-file | create-directory | remove-path | rename-path`；http=`request`；process=`spawn-and-wait`；memory=`read | write | delete`；ui=`request-confirmation`；credential-sign=`sign-request`；sealed-blob=`read-input | create-output`。Pair 按 `(broker,operation)` 排序且不重复；新增 operation 必须提升 contract version，不能通过 registry 扩展 V1。`credential-sign:sign-request` 的 input 只能是 exact SecretHandleRef metadata + nonsecret payload digest/algorithm，output 只能是 bounded signature/public metadata；没有“resolve/read/export secret” operation，broker internal handle resolution不进入 plugin ABI。

Input schema、output schema 和 permission template 的 canonical bytes **必须内嵌且带各自 domain digest**，不是 ArtifactRef，不能在 activation/registration 时从 bundle 另一个可变 path 加载。Manifest container digest 会间接绑定全部 subdocument bytes；registration 只能引用已冻结 digest，不得替换 bytes。

Pure contribution 也必须提供 canonical `permissionTemplate={"effects":[],"version":1}` 并声明 `effectsDeclared=[]`。缺失 template 不是空权限，而是 ABI error。

#### 19a.6.4 BundleBindingPayloadV1

BundleBinding 的 strict fields 为 `bindingId`、`producerId`、`publisherAssertion`、`sourceInputSetRef`、`buildInputSetRef`、`fileManifestRef`、`manifestRef`、`filesystemPolicyBindings`、`originClass`、`sourceTrustDomain`、`bindingEpoch`、`createdAtMs`。`filesystemPolicyBindings` 必须由 Manifest targets 和 §19a.6.2 closed mapping 确定性派生；`originClass` 和 `sourceTrustDomain` 由 K0 builder/catalog policy 赋值，不从 Manifest 复制。

`PublisherAssertionV1` 是最多 **4 KiB** 的 closed inline object，只含 `publisherId`、`publisherKeySetId`、`artifactName`、`artifactVersion:CanonicalSemVerV1`、`distributionChannel`、`declaredAtMs` 和 `sourceNamespace`。Id/name/namespace 使用 1..128 byte ASCII typed identifier；SemVer grammar/comparator由§19a.9.2唯一冻结；`distributionChannel` 恰为 `builtin | registry | local-import | selfdev`；时间是 safe integer。它不允许 URL、credential、free-form metadata、origin/trust/lifecycle、digest、签名或 unknown field。`producerId` 同样是 typed 1..128 byte ASCII id，并必须等于 Provenance 中 builder identity；publisher identity 的真实性来自 detached signature key registry，而不是 assertion 自报值。

Supply-chain identity invariant：PublisherAssertion `artifactName` 必须 byte-equal Manifest `capabilityId`，`artifactVersion` 必须 byte-equal Manifest `capabilityVersion`；`distributionChannel→originClass` closed mapping是 `builtin→K1`、`registry|local-import→K2`、`selfdev→K3`。CEB、CAB、Catalog candidate/installation heads/events、Activation contribution set都必须沿用同一 capability id/version/binding，不得提供覆盖副本或只比较其中一项。Catalog另分配单调 `capabilityRevision`，它不等于 SemVer或 `candidateRevision`，也不能从二者推导。任何 name/version/channel/origin/revision substitution 即使签名本身有效也拒绝。

Binding 不含 signatures、evidence/provenance/SBOM、CatalogEvidenceBinding、approval/receipt/event 或自己的 ref/digest。它是 publisher signature 的唯一 payload。

### 19a.7 Output attestations 与 CatalogEvidenceBinding

#### 19a.7.1 Same-closure attestations

`EvidenceSetV1` 含 exact `bundleBindingRef`、`signatureRefs`、`verificationEnvironment: EmbeddedCanonicalV1(role="verification-environment.v1")` 与排序的 suite/result records。Environment bytes 固定platform/filesystem policy/runtime/toolchain/sandbox/policy epoch，不允许floating identity。Suite最多64个、每suite最多256 results、全root总result最多1,024，均按typed id排序不重复。每个result含完整`verification-command.v1`、exit status、timestamp与closed sanitizedLogEvidence union。Generator必须构造1,024-result fully-valid recipe并证明D≤1MiB/N≤2MiB；1,025th命中cardinality，另有D/N one-over。

Suite/result wire不是开放测试框架对象：`VerificationSuiteV1` exact fields为`{results:VerificationResultV1[],suiteId,version:1}`，suite按suiteId、result按caseId unsigned ASCII bytes排序unique。`VerificationResultV1` exact fields为`{caseId,command:EmbeddedCanonicalV1(role="verification-command.v1"),exitStatus:VerificationExitStatusV1,finishedAtMs,sanitizedLogEvidence:SanitizedLogEvidenceV1,startedAtMs,version:1}`，要求`startedAtMs≤finishedAtMs`。`VerificationExitStatusV1`恰为`{exitClass:"EXITED",exitCode,version:1}`（exitCode 0..255）、`{exitClass:"SIGNALED",signalClass:"TERMINATED"|"ABORTED"|"KILLED"|"OTHER",version:1}`、`{exitClass:"TIMED_OUT",version:1}`或`{exitClass:"RESOURCE_KILLED",resource:"CPU"|"RSS"|"PID"|"FD"|"OUTPUT",version:1}`；cross-branch字段拒绝。

`verification-command.v1` exact fields为`{argv:ControlStringV1[],cwdLogicalPath:PortableRelativePathV1,env:VerificationEnvEntryV1[],executableBinding:ExecutableBindingV1,stdinContentDigest:null|RawContentDigestV1,stdinSize:null|SafeInteger,timeoutMs,version:1}`。Argv 1..64项，env 0..64项且`VerificationEnvEntryV1={name,value:ControlStringV1,version:1}`按name ASCII排序unique；name匹配`[A-Z_][A-Z0-9_]{0,63}`，argv+env decoded UTF-8总计≤2 KiB。stdin两字段必须同null或同present，present时由base-owned sealed NONSECRET input重算；timeoutMs为1..900000。Executable binding必须从同一BuildInputSet exact record重算，cwd只在sealed verification workspace scope解析；host path、PATH lookup、shell string、inherit env/network或unknown field全部拒绝。

`SanitizedLogEvidenceV1` 恰为两分支：`{availability:"NONSECRET",classificationLedgerBinding:NonsecretClassificationLedgerBindingV1,sanitizedLogContentDigest:RawContentDigestV1,sanitizedLogSize,version:1}` 或 `{availability:"UNAVAILABLE",reason:"MISSING"|"SECRET"|"UNKNOWN"|"INCONCLUSIVE"|"DIGEST_MISMATCH"|"SIZE_MISMATCH"|"VERDICT_MISMATCH",sanitizedLogContentDigest:null,sanitizedLogSize:null,version:1}`。`NonsecretClassificationLedgerBindingV1` 是 registry 内联的 closed bounded record，绑定 exact evidence object id、scanner id/version、verdict=`NONSECRET`、ledger generation/sequence与 purpose-scoped authority key id；不是 ArtifactRef、opaque handle或 caller label。NONSECRET 分支的 size是0..evidence-store role cap safe integer；K0 endorser必须从 K0-owned bounded evidence store读取 exact identity/size/bytes、重算 digest，并验证该 binding 对 exact object/scanner/version有 signed `NONSECRET` verdict。UNAVAILABLE 分支禁止 ledger binding、digest与 size；它只泄露上述固定 non-sensitive reason，不能泄露 secret/unknown log长度或摘要。Log path/stdout text不是 evidence record，raw secret不得进入；branch/tag/digest/size/ledger substitution或 unavailable携带非 null size全部拒绝。`known-limitations`、acceptance finding等 durable free text也必须先经同一 NONSECRET mint gate；调用端不能用“已 sanitized”标签自证。

`ProvenanceAttestationV1` 必须重复指向 binding 中 exact `sourceInputSetRef`、`buildInputSetRef`、`fileManifestRef`，并绑定 `bundleBindingRef`、same `signatureRefs`。Inline `BuilderAssertionV1` 最多 4 KiB，只含 typed `builderId`、`builderKeySetId`、`buildInvocationId`、`startedAtMs/finishedAtMs`、`reproducibilityClass`（`reproducible | best-effort`）与 `builderBinaryExternalDigest: ExternalDigestV1`；recipe/environment bytes 分别来自 exact BuildInputSet 和 EvidenceSet embedded environment，不再接受泛化摘要。Base/candidate identity 使用带 namespace/algorithm 的 `ExternalDigestV1`。Builder id 必须等于 BundleBinding `producerId`；K1/K3 production policy 必须要求 `reproducible`。

`SbomAttestationV1` 绑定 exact `fileManifestRef`、`bundleBindingRef` 和 same `signatureRefs`，并含最多 65,536 个、按 typed component id 排序的 component records 与最多 65,536 个按 path 排序的 file records，二者都拒绝 duplicate。SBOM 中的 file path 必须是 FileManifest path 的子集；声明覆盖全量时必须恰好等于全集。

这三个 node 都是 signed BundleBinding 之后的 output attestation。Publisher signatures 只证明 BundleBinding，**不证明** tests passed、builder assertion 或 SBOM clean；因此三个 node 在缺少下述 K0 endorsement 时只是 untrusted canonical claims，不能进入 CEB/human/activation authority。它们不得回填 Binding，也不得引用 endorsement、CEB、approval、completion 或 Catalog event。

#### 19a.7.2 CatalogVerificationEndorsementV1

K0 Catalog verifier 在独立读取 exact BundleBinding/signatures/Evidence/Provenance/SBOM、验证可信 participant records并执行 policy gates后，生成 `CatalogVerificationEndorsementV1`。Strict fields 为：

```text
{
  "bundleBindingRef": <exactly one>,
  "evidenceSetRef": <exactly one>,
  "knownLimitations": EmbeddedCanonicalV1(role="known-limitations.v1"),
  "participantIdentitySet": EmbeddedCanonicalV1(role="participant-identity-set.v1"),
  "priorBundleBindingRef": <zero or one>,
  "provenanceRef": <exactly one>,
  "reviewerIsolationAttestations": EmbeddedCanonicalV1(
    role="reviewer-isolation-attestation-set.v1"
  ),
  "rollbackTarget": EmbeddedCanonicalV1(role="rollback-target.v1"),
  "sbomRef": <exactly one>,
  "selfDevPromotionPlan": <K3 EmbeddedCanonicalV1 or null>,
  "selfDevRunContext": <K3 EmbeddedCanonicalV1 or null>,
  "selfDevVerificationContext": <K3 EmbeddedCanonicalV1 or null>,
  "selfDevVerificationBundle": <K3 EmbeddedCanonicalV1 or null>,
  "acceptanceReport": EmbeddedCanonicalV1(role="acceptance-report.v1"),
  "signatureRefs": <exact ordered publisher signatures>,
  "verifiedAtMs": <time>,
  "expiresAtMs": <time>,
  "policyEpoch": <snapshot>,
  "trustEpoch": <snapshot>,
  "revocationEpoch": <snapshot>,
  "version": 1
}
```

该 payload 必须由 §19a.11 `keyPurpose="catalog-verification-endorser"` 的 K0 detached artifact authority envelope签名；envelope signer、bundle publisher、builder、evidence runner、SBOM generator和每个 independent reviewer必须来自 current purpose-scoped registry，并按 required-separation policy比较 public-key fingerprint（如有）及下述全部 stable identity/session/context维度，而不是只比较 caller id。K3 的 frozen set必须保留 §18 本 run **已经 performed 与后续 designated 的完整 participant set**，不能只保留当前签名者。K1/K2 尚未知的未来 adoption/enable approver不能被 endorsement 猜测，必须在各 receipt issue时按 current registry和该 endorsement participant set重新做 policy-required independence检查。

`participant-identity-set.v1`含1..64项，按`(actorKind,runRole,purposeDomain,actorId,participation)`排序unique；每项exact fields为`{actorId,actorKind:"human"|"model"|"service",contextSourceIdentity,credentialBinding:EmbeddedCanonicalV1(role="credential-binding.v1"),executionDomain,expiresAtMs,isolatedSessionId,issuedAtMs,participation:"performed"|"designated",principalBinding:EmbeddedCanonicalV1(role="principal-binding.v1"),purposeDomain,runRole,version:1}`。K3 required inventory的literal `(actorKind,runRole)` pairs恰为：human/run-owner、human/human-approver、model/developer、model/reviewer、service/orchestrator、service/verifier、service/reviewer、service/promotion-approval-consumer、service/catalog-stage-worker、service/git-promotion-worker、service/selfdev-completion-worker、service/selfdev-transition-finalizer、service/journal-anchor、service/builder、service/evidence-runner、service/sbom-generator、service/catalog-endorser。每个designated record在freeze时存在且purposeDomain exact=`selfdev.participant.<runRole>.v1`。Consumer与三worker是§18 promotion-worker ABI subroles；finalizer是durable K0 HSM service。Stage/Git signer匹配各worker，anchored final receipt signer匹配finalizer，pre-anchor human/consumer/completion authorization匹配各自actor；missing/duplicate/reissued-role substitution拒绝。

`IdentityCommitmentV1` exact shape是 `{algorithm:"hmac-sha256-256",commitmentDomainId,value:<32 bytes base64url/no-padding>,version:1}`。它只能由唯一 protected identity-registry service从已验证的 authoritative identity mapping计算；caller、actor 和 purpose-scoped issuer均不能传 stable tuple 或 commitment value。Service 将 underlying identity映射为下列 internal-only closed tuple之一：`StablePrincipalIdentityTupleV1={identityKind:"principal",registryNamespace,stableIdentityBytesBase64Url,version:1}` 或 `StableCredentialIdentityTupleV1={identityKind:"credential",registryNamespace,stableIdentityBytesBase64Url,version:1}`；namespace 是1..128 ASCII，stable bytes 是1..256 raw bytes的 strict base64url/no-padding。Tuple 使用 Canonical JSON V1，原 bytes无 Unicode/locale/case normalization；issuer-local id、actor id、role、session、binding id 或 credential record id均不得进入 tuple。

Exact derivation 为：

```text
principalCommitmentPreimage =
  ASCII("plugin-kernel-principal-identity-commitment\0v1\0") ||
  uint64_be(len(commitmentDomainIdBytes)) || commitmentDomainIdBytes ||
  uint64_be(len(stablePrincipalTupleCanonicalBytes)) ||
  stablePrincipalTupleCanonicalBytes

credentialCommitmentPreimage =
  ASCII("plugin-kernel-credential-identity-commitment\0v1\0") ||
  uint64_be(len(commitmentDomainIdBytes)) || commitmentDomainIdBytes ||
  uint64_be(len(stableCredentialTupleCanonicalBytes)) ||
  stableCredentialTupleCanonicalBytes

value = base64url_no_padding(HMAC-SHA256(commitmentDomainGenerationKey,
                                         exactPreimage))
```

`commitmentDomainId` 是 trust policy冻结的1..128 ASCII nominal id，不由 actor选择；同一 underlying identity在所有 accepted issuers/roles/sessions必须经 registry得到同 tuple/domain/value，principal 与 credential 因 prefix 不同永不能 type-alias。HMAC key/preimage/tuple不导出，commitment只用于 protected registry equality与 separation checks，不是 bearer authority。ABI V1 的 commitment domain/key在本 trust generation内 immutable；rotation/compromise必须 revoke该 generation并经新 contract/trust migration重新建立历史连续性，在完成前不能把 new value当独立主体或继续旧 evidence。

为与 §18 的无环方向一致，**credential 是独立叶子，principal 单向绑定 credential**：

- `credential-binding.v1` 是 ≤4 KiB closed record `{credentialClass,credentialRecordId,expiresAtMs,issuedAtMs,issuerKeyFingerprint,opaqueCredentialCommitment:IdentityCommitmentV1,publicKeyFingerprint,registryEpoch,revocationEpoch,version:1}`；`credentialClass` 恰为 `human-key | model-session | service-key | workload-key`，`credentialRecordId` 是32 random bytes base64url，public fingerprint可为 null或 §19a.3 32-byte key fingerprint。该 payload **MUST NOT** 含 principal id/digest/container。
- `principal-binding.v1` 是 ≤4 KiB closed record `{actorClass,credentialBindingCanonicalDigest:CanonicalPayloadDigestV1(role="credential-binding.v1"),executionDomain,expiresAtMs,issuedAtMs,issuerKeyFingerprint,principalId,principalSubjectCommitment:IdentityCommitmentV1,registryEpoch,revocationEpoch,version:1}`；`actorClass` 恰为 `human | model | service | workload`。该 typed credential digest必须从同一 Participant/HumanParticipant sibling `credentialBinding` exact decoded bytes重算，不能由 caller另给。

两个 commitment永远 non-null，并在同一 trust/identity domain内跨 binding id、credential record id、session和renewal保持稳定。Participant/human verifier必须先独立验证 credential bytes/issuer/epoch/validity/revocation/commitment，再验证 principal bytes及其 embedded typed credential digest，然后要求 principal digest绑定的 credential 与 containing sibling credential byte-equal；不得反向要求 credential引用 principal。Unknown/wrong-role/stale record、只给摘要、`principal_A + credential_B`交换、同 principal 换发 credential container但 digest未更新、或任何双向 digest环都拒绝。Registry lookup bytes/occurrence计入 closure budget，但内部 registry key不是 wire authority。

Isolation/independence比较必须同时覆盖 `actorId`、principal/credential binding canonical digests、`principalSubjectCommitment`、`opaqueCredentialCommitment`、非 null public-key fingerprint、`isolatedSessionId`、context-source identity与 purpose/role。任何一个 required-separate pair在任一稳定维度相同都不独立；换发 actor/principal/credential record id、另开 session或把 `publicKeyFingerprint` 设 null不能掩盖同一 underlying subject/credential。Commitment缺失/不可验证时不是“未知所以独立”，而是 fail closed。Caller不能提交 forbidden/exclusion list，verifier从完整 frozen set与 base separation policy派生。

`acceptance-report.v1` 绑定从 endorsement顶层 exact refs重算的 role-typed Evidence/Provenance/SBOM canonical digests、participant set digest、reviewer-isolation set digest、policy/risk/classification、required reviewer count、deterministic gate verdict和 aggregate advisory=`accept`。`reviewer-isolation-attestation-set.v1` 至少一项并按 reviewer identity排序；每项绑定 fresh reviewer-only principal/session/context source、typed input decoder/runtime/profile，以及 EvidenceSet 内已验证 `(suiteId,caseId)` closed bindings，且无 write/network/approval/promotion capability。`known-limitations.v1` 即使为空也必须显式存在，最多 128 项、每项含 closed severity/category、1..512-byte canonical nonsecret text和 EvidenceSet内 typed suite/case id。Portable `rollback-target.v1` 是 closed union：无 prior时 `{capabilityId,priorBundleBindingCanonicalDigest:null,strategy:"disable-only",version:1}`；有 endorsement顶层 `priorBundleBindingRef` 时 `{capabilityId,priorBundleBindingCanonicalDigest:CanonicalPayloadDigestV1(role="bundle-binding-payload.v1"),strategy:"disable-and-restore-prior-verified-bundle",version:1}`，digest必须从该 top-level ref fetched bytes重算。它不得包含 ArtifactRef、尚未创建的 CAB/target installation domain/current target head。Target-specific current head、installation-domain rollback intent在 CAB/adoption SafeDisplay/receipt中另行绑定。这些 bytes全在 endorsement signature 内，不能以后补写。

Endorsement embedded docs **MUST NOT** 含 JournalDigest、opaque storage key或泛化 digest。唯一 ArtifactRef例外是 K3 sibling `selfDevPromotionPlan.bundleBindingRef` exactly one，它必须 field-equal endorsement顶层 `bundleBindingRef`并作为额外 occurrence计入 rank/closure budgets；CEB复制该 plan时该 occurrence也重新计数。其余 embedded docs的 ArtifactRef基数为零；其中任何 cross-object identity/digest/link只能 (a) 重复 top-level已验证对象的 role-typed canonical digest并要求重算 byte-equal，(b) 使用 EvidenceSet内 bounded typed ids，或 (c) 在 Participant/HumanParticipant字段内携带从 protected trust registry按 typed id重读且 byte-equal 的 `principal-binding.v1`/`credential-binding.v1` containers。其余内容只允许该 role在 registry声明的 bounded inline scalar/record（如 policy rule、risk/verdict、NONSECRET limitation text、rollback strategy）；第三类以外的 nested container及任何 unknown ref/handle仍禁止。Nested-ref smuggling、unknown evidence id或 prior digest无对应 top-level ref都拒绝。

K3 endorsement 必须在签名之前已有唯一 frozen `selfDevPromotionPlan: EmbeddedCanonicalV1(role="selfdev-promotion-plan.v1")`、`selfDevRunContext: EmbeddedCanonicalV1(role="selfdev-run-context.v1")` 和 `selfDevVerificationContext: EmbeddedCanonicalV1(role="selfdev-verification-context.v1")`。Plan 按 §19a.8 生成且只能引用 BundleBinding/source identities，绝不引用 endorsement/CEB/receipt。Verification context 是 ≤64 KiB 的 strict control document，内含同一 run/base/candidate 的 effective self-development policy rule records、task classification result + attestation records、`verificationEnvironmentCanonicalDigest: CanonicalPayloadDigestV1(role="verification-environment.v1")`、baseline suite/case typed ids和 verifier principal/runtime/profile records。Endorser必须从顶层 EvidenceSet embedded environment exact bytes重算该 digest，baseline ids也必须解析到同一 EvidenceSet，不允许独立 env-A；policy epoch与 plan、classification run/candidate与 Provenance、verifier binding与 ParticipantIdentitySet对应记录都必须 byte-equal。Context nested records是 registry-closed inline data，只允许真正外部 source/runtime identity使用 `ExternalDigestV1`，不含自身摘要、ArtifactRef、opaque handle或未给 bytes 的 canonical digest。

`NonsecretUtf8BytesV1` exact shape为`{bytesBase64Url,classificationLedgerBinding:NonsecretClassificationLedgerBindingV1,contentDigest:RawContentDigestV1,size,version:1}`；decoded bytes必须strict UTF-8但Canonical JSON C0禁令不应用于decoded carrier，原LF/CRLF/TAB bytes不normalize，size/digest从原bytes重算且ledger verdict exact NONSECRET。`selfdev-run-context.v1` 是≤128 KiB closed ApprovalContext replacement，exact fields为`{acceptanceCriteria:NonsecretUtf8BytesV1[],baseRef,baseRevision,budgetLimits,budgetUsage,candidateRevision,capabilityId,capabilityRevision,capabilityRevisionAllocationCanonicalDigest,capabilityRevisionAllocationId,goalText:NonsecretUtf8BytesV1,generation,participantIdentitySetCanonicalDigest,policyEpoch,reconciledLineageDependencyCanonicalDigest:null|CanonicalPayloadDigestV1(role="reconciled-lineage-dependency.v1"),repairAttempts,repairGeneration,repairLimit,revocationEpoch,runId,selfDevPromotionPlanCanonicalDigest,selfDevVerificationContextCanonicalDigest,trustEpoch,version:1}`。Goal≤4KiB、每criterion≤1KiB、criteria≤64且保留原bytes；budget逐维完整。Sibling digests与base/candidate/revision/run/generation逐字段重算，无CEB/approval/future-head backref。Terminal marker存在时dependency必需，否则null。Corpus覆盖multiline LF、CRLF与no-normalization byte差异。

`selfdev-verification-bundle.v1` 是 §18 `VerificationBundle` 的无环 ABI replacement，不能含糊地照抄旧 interface。Exact mapping 固定为：

| §18 field | ABI V1 strict replacement |
|---|---|
| `schemaVersion` | `version=1` |
| `runId/baseRef/baseSha/candidateDigest` | `runId/baseRef/baseRevision/candidateRevision`，typed values 与 promotion-plan、Provenance、SourceInputSet byte-equal；Git object algorithm服从 repository object format |
| `policyDigest/taskClassificationResultDigest/taskClassAttestationDigest/environmentDigest/baselineBundleDigest/verifierDigest` | 单一 `selfDevVerificationContextCanonicalDigest: CanonicalPayloadDigestV1(role="selfdev-verification-context.v1")`，必须从 endorsement sibling context exact bytes重算；各原字段的内容都在该 sibling strict records中，不接受六个 caller摘要 |
| `promotionPlanDigest` | `selfDevPromotionPlanCanonicalDigest: CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1")`，必须从 endorsement sibling plan exact bytes重算 |
| `candidate/holdouts/safetyChecks` | 三个按 `(suiteId,caseId)` 排序去重的 bounded typed-id列表；每项必须解析到 endorsement顶层 EvidenceSet的 exact result，不能放 ArtifactRef |
| `artifacts` | 删除；唯一 artifacts 是 endorsement顶层具名 Binding/Evidence/Provenance/SBOM/signature refs，其 typed digests从 fetched canonical bytes重算 |
| `verdict/completedAt` | 保留，K3 endorsement只接受 `verdict="pass"` 且时间不晚于 `verifiedAtMs` |
| `bundleDigest` | 删除；外层 `EmbeddedCanonicalV1` role-separated digest是唯一 verification-bundle digest，禁止 direct self-digest |

`acceptance-report.v1`、reviewer isolation records和 participant records对 §18 同样应用“删除自身 `*Digest`、由外层 container digest替代”的规则；它们对 policy/plan/verification/participant的绑定必须从上述 sibling containers重算 role-typed digest。CEB 之后内嵌的 plan container必须与 endorsement sibling container所有字段 byte-for-byte 相同，不能重新构造第二份 plan。ParticipantIdentitySet、AcceptanceReport、ReviewerIsolationAttestation 不再作为 §18 可被 closed ABI 丢弃的旁路对象；上述 containers 是它们在 plugin-kernel closure 中的唯一映射，并保留全部 performed/designated run roles、purpose domains、session/context identities与 issuer-authenticated stable commitments。K1/K2 必须 `selfDevVerificationBundle=null`，但 participant/independent acceptance/limitations/rollback仍必须存在。任何 self-attestation、cross-role key、missing/expired endorsement、participant set/role drift、用 reissued id/null key伪造“independence”、non-pass/inconclusive gate、mixed output ref或 limitation/rollback替换都拒绝。

#### 19a.7.3 CatalogEvidenceBindingV1

CEB 是 catalog/human decision 的唯一 supply-chain 对象，strict fields 为：

```text
{
  "bindingId": <typed id>,
  "bundleBindingRef": <exactly one>,
  "catalogVerificationEndorsementRef": <exactly one>,
  "evidenceSetRef": <exactly one>,
  "originClass": "K1" | "K2" | "K3",
  "permissionProjection": EmbeddedCanonicalV1(
    role="catalog-permission-projection.v1"
  ),
  "provenanceRef": <exactly one>,
  "requiredSandboxFeatures": EmbeddedCanonicalV1(
    role="sandbox-feature-requirements.v1"
  ),
  "sbomRef": <exactly one>,
  "selfDevPromotionPlan": <K3 EmbeddedCanonicalV1 or null>,
  "signatureRefs": <exact ordered 1..16>,
  "sourceTrustDomain": <immutable source domain>,
  "version": 1
}
```

`catalog-permission-projection.v1` 是从 Manifest contributions 的 exact input-schema、permission-template bytes、`effectsDeclared`、resource envelope 与 contribution ids 按固定排序纯派生的 canonical object；它必须表达每个 template `select` 可达字段/type/bound和最大 broker target/request/budget envelope，不得只列 operation 名，也不得读取 policy/current approval。`sandbox-feature-requirements.v1` 是从 Manifest `minSandboxFeatures` 和 resource envelope 按 closed feature order 纯派生的 canonical object。CEB verifier 必须从已验证 Manifest 重建两份 bytes，并要求 embedded role/size/`CanonicalPayloadDigestV1` 全部相同；不能接受调用端提供的裸摘要。

CEB verifier MUST 完整打开三个 attestation和 endorsement，证明它们的 binding/signature/output refs 与 CEB byte-equal，验证 endorsement authority/participants/acceptance/limitations/rollback，再追到 Binding 的 source/build/FileManifest/Manifest closure。只验 CEB 外层 digest、把 publisher signature 当 output endorsement、只验某个 attestation，或把不同 bundle 的 evidence/provenance/SBOM/endorsement 拼在一起都拒绝。

K1/K2 必须 `selfDevPromotionPlan=null`。K3 必须内嵌 role=`selfdev-promotion-plan.v1` 的 canonical plan，不允许 null，并要求整个 `EmbeddedCanonicalV1` container byte-for-byte equal endorsement 的 `selfDevPromotionPlan`；CEB verifier不得另行生成或只比较 plan digest。`originClass`、`sourceTrustDomain` 必须与 BundleBinding 完全一致；CEB 不能改写它们。

### 19a.8 SelfDevPromotionPlan 与 promotion receipts

#### 19a.8.1 Frozen plan

K0 必须在 K3 verification/endorsement、CEB 和 human prompt **之前**产生唯一 canonical `SelfDevPromotionPlanV1`；后续 endorsement 与 CEB 只能复制同一 container bytes。它包含：

- `runId`、`capabilityId`、canonical full `baseRef`、`baseRevision: ExternalDigestV1(namespace="git-object")`、`candidateRevision: ExternalDigestV1`、`bundleBindingRef`、monotonic Catalog `capabilityRevision`、`capabilityRevisionAllocationId`、`capabilityRevisionAllocationCanonicalDigest: CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1")`、`policyEpoch`、`revocationEpoch`、`trustEpoch`。
- `reconciledLineageDependency:null|EmbeddedCanonicalV1(role="reconciled-lineage-dependency.v1")`；plan/endorsement/CEB逐字复制唯一bytes，run context与decision只携从该sibling重算的typed digest。Terminal marker存在时required，否则null。
- `catalogStageEffectPlan: EmbeddedCanonicalV1(role="catalog-stage-effect-plan.v1")`。
- `gitPromotionEffectPlan: EmbeddedCanonicalV1(role="git-promotion-effect-plan.v1")`。
- 两个 effect plan 的 common exact fields 是 `runId/capabilityId/baseRef/baseRevision/candidateRevision/capabilityRevision/effectId/idempotencyKey:IdempotencyKeyV1/target/writeIntent/leaseDeadlineMs/version`；它们**不得**含 `bundleBindingRef` 或任何其他 ArtifactRef。Bundle authority只来自 containing `SelfDevPromotionPlanV1.bundleBindingRef`，executor不得脱离 parent plan单验 effect plan；Git effect 明确需要未来 reservation id/fence 作为执行时输入。

`git-promotion-effect-plan.v1` 保留 §18 deterministic Git contract，不得简化成 branch name + commit digest。它在上一条明确列出的 effect-plan common exact fields（不含 `bundleBindingRef`）外必须含：canonical full local `baseRef`、`baseSha: ExternalDigestV1(namespace="git-object")`、new `promotionRef`、repository `objectFormat="sha1" | "sha256"`、`commitObjectPlan` 和 `refTransactionPlan`。`GitFullHeadsRefV1` 是总长 `12..1024` ASCII bytes、literal `refs/heads/` 加1..32个 `/` 分隔 segment 的 closed grammar；每个 segment长1..255且字符只能 `[A-Za-z0-9._-]`，不得以`.`开头或结尾、不得以`.lock`（ASCII case-sensitive）结尾，full ref不得含 `..`、`@{`、leading/trailing/repeated slash、space/control、`~ ^ : ? * [ \\`、lone `@`，也不得等于/解析为 `HEAD`。`baseRef`/`promotionRef`必须是 policy-approved该 nominal type；symbolic/tag/remote/refspec全部拒绝，`promotionRef` 在 plan 时必须不存在。实现不得调用 host/version-dependent `check-ref-format` 来扩宽或收窄该 byte language。

`commitObjectPlan` exact fields 是 `rawEncoding="git-commit-object-v1"`、tree object id、`parentObjectIds=[baseSha]` exactly、`author:GitIdentityV1`、`committer:GitIdentityV1`、fixed timestamp/timezone、`extraHeaders=[]`、fixed literal `signaturePolicy={mode:"unsigned-v1",version:1}`、message `{bytesBase64Url,size,contentDigest:RawContentDigestV1}`（decoded ≤2 KiB）、`rawCommitPayload` 同 shape（decoded ≤8 KiB）与 `expectedCommitObjectId: ExternalDigestV1(namespace="git-object")`。`GitIdentityV1={emailBytesBase64Url,nameBytesBase64Url,timestampSeconds,timezoneOffset,version:1}`；name decoded 为1..128 bytes、email 为3..254 bytes，两者均必须 valid UTF-8、保持 no-normalization byte identity，并禁止 NUL/LF/CR、`<`、`>`、C0/C1 controls、Unicode noncharacters及 bidi controls。Email 还必须符合 registry 冻结的 single-line ASCII addr-spec subset，不接受 comment/quoted local/domain literal。`timestampSeconds` 是 non-negative safe integer；`timezoneOffset` 恰匹配 ASCII `[+-](?:[01][0-9]|2[0-3])[0-5][0-9]`。

V1 `extraHeaders` **必须 literal empty array**；`gpgsig`、`encoding`、mergetag、continuation line 或任何非空/unknown header全部拒绝，因而 payload中只能有按顺序的 `tree`、唯一 `parent`、`author`、`committer`四个 structural headers。Trusted serializer 的唯一 grammar是 `tree <oid>\nparent <baseOid>\nauthor <name> <email> <timestamp> <timezone>\ncommitter <name> <email> <timestamp> <timezone>\n\n<messageBytes>`，其中 identity framing exact 为 decoded `nameBytes || ASCII(" <") || emailBytes || ASCII("> ") || decimalTimestamp || ASCII(" ") || timezone || LF`，message 原 bytes之后不自动添加 LF。Raw payload必须与该 serializer byte-equal；duplicate/injected tree/parent/author/committer、identity delimiter injection、header continuation、额外 blank line或 implicit final newline都拒绝。Repository `objectFormat="sha1"` 唯一映射 ExternalDigest algorithm=`git-sha1`，`objectFormat="sha256"` 唯一映射 algorithm=`git-sha256`；base/tree/parent/expected/actual OID 全部必须用同一映射，raw `sha256` 永不代替 Git-object sha256。Trusted serializer 必须以 exact Git object bytes `ASCII("commit "+decimal_byte_len)+NUL+payload` 重算 expected OID；所有 implicit clock/identity/config/encoding/signing 都禁止。

`refTransactionPlan` exact fields 是 `verifyBase={ref:baseRef,expectedObjectId:baseSha}` 与 `createPromotion={ref:promotionRef,expectedOldObjectId:null,newObjectId:expectedCommitObjectId}`；`null` 唯一表示 repository-format all-zero OID。Execution profile 固定 `inheritGitConfig=false`、`hooks=false`、`credentialHelpers=false`、`signing=false`、`network=false`、empty env allowlist。Promotion worker 只能用 typed low-level object API，并在**一个** trusted Git ref transaction 中 verify base + expected-zero create；preflight read、porcelain commit、先 verify 后单独 update-ref、merge/rebase/push/tag 都不合规。

K3 candidate-to-tree derivation 也是 machine invariant：`candidateRevision` 必须是 namespace=`selfdev-candidate-manifest` 的 ExternalDigestV1，trusted builder按 exact candidate manifest 解出同 repository object format 的 **source** `gitTreeObjectId`，并逐 source path/mode/raw-content digest证明 candidate manifest与该 tree一致。Provenance/SourceInputSet/BuildInputSet必须进一步证明这个 exact source tree经 frozen recipe/toolchain生成 Bundle FileManifest output，SelfDevVerificationBundle同时绑定 source tree和 tested output closure；只有显式 `buildMappingClass="source-as-bundle"` 时才要求 source tree与 bundle files逐文件相等。`CommitObjectPlan.treeObjectId` 必须 byte-equal verified source tree；expected commit OID只能由该 tree、`parent=[baseSha]`与 frozen metadata/raw payload重算。Candidate digest相同但 tree substitution、unverified source→output mapping、object-format mismatch或测试后重写 tree全拒绝。

Plan 不是 ArtifactRef node；它先作为 §19a.4 `EmbeddedCanonicalV1` 被完整内嵌进将要签名的 endorsement，CEB再逐字复制同一 container。Plan可向下绑定已存在的 BundleBinding，但 MUST NOT包含 endorsement/CEB digest/ref、任何 approval/effect/completion receipt、Catalog event、自己的 digest/EmbeddedCanonical container，或未来才会生成的 reservation/fence值。这个时间顺序消除 `plan ↔ endorsement/CEB ↔ approval` 的直接或间接 digest cycle。

Machine invariant `K3-PLAN-BINDING-V1` 不只比较一个 ref：`SelfDevPromotionPlanV1.bundleBindingRef` 必须与 enclosing `CatalogEvidenceBindingV1.bundleBindingRef` 做 canonical field-by-field **byte equality**；`capabilityId` 必须等于 Binding→Manifest capability；`baseRef/baseRevision/candidateRevision` 必须分别等于 exact Provenance/selfdev verification bundle 已由 Source/Build closure证明的 typed identities；`capabilityRevision/capabilityRevisionAllocationId/capabilityRevisionAllocationCanonicalDigest` 必须等于 exact CandidateHead 中由 allocator已分配的 current attempt fields，并从 Catalog allocation store重读 exact bytes重算。两个 embedded effect plans的 `runId/capabilityId/baseRef/baseRevision/candidateRevision/capabilityRevision/target/writeIntent` 必须与 parent plan byte-equal，并由 parent唯一 `bundleBindingRef`共同授权；各自 `effectId/idempotencyKey/leaseDeadlineMs` 是 parent plan内不可改写的 effect-specific值。Effect plan中出现 `bundleBindingRef` 必须因 unknown field拒绝。后续 PromotionApproval/CatalogStage/GitPromotion/Completion receipts也必须延续这些 exact values与原始 deadlines。任何只比较 `bindingId`/digest hex、alternate serialization或单字段 substitution 都拒绝。K1/K2 没有 plan，不能伪造该 invariant 的空值版本。

`K3-GIT-BASE-EQUALITY-V1` 是额外 exact invariant，不接受“同 commit但另一个 ref”或无 namespace digest：`SourceInputSet.baseRef == SelfDevVerificationBundle.baseRef == SelfDevPromotionPlan.baseRef == CatalogStageEffectPlan.baseRef == GitPromotionEffectPlan.baseRef == refTransactionPlan.verifyBase.ref == GitPromotionReceipt.verifiedBaseRef`，且 `SourceInputSet.baseRevision == SelfDevVerificationBundle.baseRevision == SelfDevPromotionPlan.baseRevision == both effect plans.baseRevision == gitPromotionEffectPlan.baseSha == commitObjectPlan.parentObjectIds[0] == refTransactionPlan.verifyBase.expectedObjectId == GitPromotionReceipt.baseObjectId`。所有 object-id fields的 namespace必须 literal `git-object`，algorithm由 repository `objectFormat` 唯一映射 `sha1→git-sha1` / `sha256→git-sha256`。Verifier必须从 exact bundle closure、verification bytes与 Git repository state各自重算后比较；任何 base ref、namespace、algorithm、parent或 verifyBase substitution都拒绝。

Effect executor 从 CEB 解出内嵌 plan，重算 plan/effect-plan digests，并要求 runtime `run/base/candidate/binding/capabilityRevision/epochs/effectId/idempotencyKey/target/writeIntent/leaseDeadlineMs` 全部相同。不得只比较 plan digest 字符串而不验证 embedded bytes。

#### 19a.8.2 Promotion-only approval and effects

SelfDev run journal 与 Catalog journal 是不可互换的nominal domain。`selfdev-run-journal-event.v1` exact payload是`{eventKind,generation,occurredAtMs,previousEventDigest:SelfDevRunJournalDigestV1|null,runId,sequence,stateAfter,stateBefore,stateVersionAfter,stateVersionBefore,subjectCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),version:1}`。`sequence`与`stateVersionAfter`均为其predecessor对应值checked+1；唯一ABI genesis ENTER_AWAITING event使用`sequence=0,previousEventDigest=null`但仍要求§18 current ACCEPTING stateVersion的checked transition。Stage/Git与post-terminal release无event variant；final receipt digest/future anchor forbidden，依赖方向只可intent→event→checkpoint/anchor→final object。

`selfdev-run-transition-subject.v1` 是≤16 KiB、无post-anchor的exact closed union。Common fields恰为`{commitWindow:TransitionCommitWindowV1,eventKind,expectedPreRunJournalAnchorCanonicalDigest:null|CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),expectedPreState,expectedPreStateVersion,finalMaterializationRole:"none"|"promotion-approval-receipt.v1"|"promotion-approval-consumption.v1"|"selfdev-completion-receipt.v1"|"promotion-terminal-failure.v1",finalizerParticipantIdentitySetCanonicalDigest:CanonicalPayloadDigestV1(role="participant-identity-set.v1"),finalizerParticipantMemberKey:{actorId,actorKind:"service",participation:"designated",purposeDomain:"selfdev.participant.selfdev-transition-finalizer.v1",runRole:"selfdev-transition-finalizer",version:1},generation,intentId,resultState,resultStateVersion,runId,version:1}`；member key必须在exact set中解析到唯一record，`resultStateVersion=checked(expectedPreStateVersion+1)`。Branches恰为：

| `eventKind` | exact required branch fields / state pair | forbidden |
|---|---|---|
| `ENTER_AWAITING` | `ACCEPTING→AWAITING_HUMAN`；`acceptanceReportCanonicalDigest:CanonicalPayloadDigestV1(role="acceptance-report.v1"),catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),orchestratorAuthoritySubject:SelfDevOrchestratorAuthoritySubjectV1(transitionKind="ENTER_AWAITING"),participantIdentitySetCanonicalDigest:CanonicalPayloadDigestV1(role="participant-identity-set.v1"),selfDevRunContextCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-context.v1"),selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1")`；`expectedPreRunJournalAnchorCanonicalDigest=null`仅在ABI journal genesis；`finalMaterializationRole="none"` | challenge/human decision/approval/effect/reservation/terminal fields |
| `APPROVAL` | `AWAITING_HUMAN→APPROVED`；`approvalTransitionCore:PromotionApprovalTransitionCoreV1,expectedAwaitingHumanRunHeadSubject:SelfDevRunHeadSubjectV1(state="AWAITING_HUMAN")`；`finalMaterializationRole="promotion-approval-receipt.v1"` | consumer/effect/completion/failure fields |
| `CONSUMPTION` | `APPROVED→PROMOTING`；`consumptionTransitionCore:PromotionConsumptionTransitionCoreV1,expectedApprovedRunHeadSubject:SelfDevRunHeadSubjectV1(state="APPROVED")`；`finalMaterializationRole="promotion-approval-consumption.v1"` | human challenge/display/effect result/failure fields |
| `COMPLETION` | `PROMOTING→COMPLETED`；`completionTransitionCore:PromotionCompletionTransitionCoreV1,expectedPromotingRunHeadSubject:SelfDevRunHeadSubjectV1(state="PROMOTING")`；`finalMaterializationRole="selfdev-completion-receipt.v1"` | human/consumer/failure fields |
| `TERMINAL_FAILURE` | `PROMOTING→FAILED`；`expectedPromotingRunHeadSubject:SelfDevRunHeadSubjectV1(state="PROMOTING"),orchestratorAuthoritySubject:SelfDevOrchestratorAuthoritySubjectV1(transitionKind="TERMINAL_FAILURE"),terminalFailureTransitionCore:PromotionTerminalFailureTransitionCoreV1`；`finalMaterializationRole="promotion-terminal-failure.v1"` | receipt success/human/consumer fields |

上述五种 branch 引用的 inline records 也是 single registry 的 closed records，不是可扩展 map：

- `SelfDevOrchestratorAuthoritySubjectV1` exact fields为`{authorizedState:"ACCEPTING"|"PROMOTING",authorizedStateVersion,expiresAtMs,generation,leaseId,orchestratorParticipantCanonicalDigest:CanonicalPayloadDigestV1(role="participant-identity-set.v1"),runId,runWorkerFence:RunWorkerFenceV1,terminalGeneration:null|SafeInteger,transitionKind:"ENTER_AWAITING"|"TERMINAL_FAILURE",version:1}`。ENTER_AWAITING恰配`ACCEPTING`且terminalGeneration=null；TERMINAL_FAILURE恰配`PROMOTING`且terminalGeneration non-null。Participant digest必须解析到frozen designated orchestrator record；state/transition/nullability cross-pair拒绝。
- `PromotionApprovalTransitionCoreV1` exact fields为`{approvalContextCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-approval-context.v1"),awaitingHumanRunJournalAnchorCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),bundleBindingCanonicalDigest:CanonicalPayloadDigestV1(role="bundle-binding-payload.v1"),capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),catalogEvidenceBindingRef:ArtifactRefV1(role="catalog-evidence-binding.v1"),challengeId,challengeNonce,expiresAtMs,humanDecisionCanonicalDigest:CanonicalPayloadDigestV1(role="human-decision.v1"),humanKeyId,humanKeyPurpose:"human-promotion-decision",humanParticipantCanonicalDigest:CanonicalPayloadDigestV1(role="human-participant-binding.v1"),humanSignatureBase64Url,issuedAtMs,policyEpoch,revocationEpoch,runId,safeDisplayCanonicalDigest:CanonicalPayloadDigestV1(role="safe-display.v1"),selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),trustEpoch,version:1}`；signature strict-decode恰64 bytes并在intent/event前验证。
- `PromotionConsumptionTransitionCoreV1` exact fields为`{approvalConsumerAuthoritySubject:ApprovalConsumerAuthoritySubjectV1,approvalConsumerPermitCanonicalDigest:CanonicalPayloadDigestV1(role="approval-consumer-permit.v1"),capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,consumedAtMs,effectivePromotionDeadlineMs,promotionApprovalReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-receipt.v1"),promotionApprovalReceiptRef:ArtifactRefV1(role="promotion-approval-receipt.v1"),reservationId,selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),version:1}`。
- `PromotionCompletionTransitionCoreV1` exact fields为`{capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),catalogStageReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-receipt.v1"),catalogStageReceiptRef:ArtifactRefV1(role="catalog-stage-receipt.v1"),completionWorkerAuthoritySubject:PromotingWorkerAuthoritySubjectV1(workerRole="selfdev-completion-worker"),completionWorkerPermitCanonicalDigest:CanonicalPayloadDigestV1(role="completion-worker-permit.v1"),deadlineRecord:PromotionDeadlineRecordV1,gitPromotionReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="git-promotion-receipt.v1"),gitPromotionReceiptRef:ArtifactRefV1(role="git-promotion-receipt.v1"),promotionApprovalConsumptionCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-consumption.v1"),promotionApprovalReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-receipt.v1"),promotionApprovalReceiptRef:ArtifactRefV1(role="promotion-approval-receipt.v1"),reservationId,selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),version:1}`。
- `PromotionTerminalFailureTransitionCoreV1` exact common fields为`{capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,expectedReservationRevision,expectedReservationState:"STAGE_PENDING"|"AMBIGUOUS_BLOCKED",failureKind:"EXPIRED"|"AMBIGUOUS",reason:"recovery_failed",reservationId,terminalGeneration,version:1}`。EXPIRED branch另且只含`absenceProof:{catalogStageReceiptCanonicalDigest:null,gitPromotionReceiptCanonicalDigest:null,linearizableSnapshotRevision,observedAtMs,pointerReservationId,reservationState:"STAGE_PENDING",version:1}`并要求`expectedReservationState="STAGE_PENDING"`；AMBIGUOUS branch另且只含`terminalMarker:PromotionTerminalMarkerV1`并要求`expectedReservationState="AMBIGUOUS_BLOCKED"`。`PromotionTerminalMarkerV1={markedAtMs,markerId,outboxId,terminalGeneration,version:1}`；其terminalGeneration必须与core/common和current protected terminal-generation store相等。Absence proof在同transaction锁exact run/reservation/receipts/pointer keys；两branch不得携对方字段。

`PromotionDeadlineRecordV1` exact fields为`{catalogStageLeaseDeadlineMs,catalogVerificationEndorsementExpiresAtMs,effectivePromotionDeadlineMs,gitPromotionLeaseDeadlineMs,promotionApprovalExpiresAtMs,version:1}`，effective值必须是前四者minimum。Finalizer必须匹配selected frozen set member的principal/credential/key；ENTER_AWAITING的`finalMaterializationRole="none"`仍由anchor finalizer签event/checkpoint/anchor而不生成receipt。Unknown、null代替required、cross-branch字段或intent包含自身/future event/checkpoint/anchor/final receipt digest全部拒绝。

`selfdev-run-journal-checkpoint.v1` exact payload是`{anchorVersion,checkpointSequence,currentRunJournalDigest:SelfDevRunJournalDigestV1,generation,journalStoreGeneration,journalStoreId,policyEpoch,revocationEpoch,runId,state,stateVersion,trustEpoch,version:1}`。`SelfDevCheckpointHeadV1`是read-only source selector `{anchorVersion,checkpointCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-journal-checkpoint.v1"),checkpointSequence,currentRunJournalDigest:SelfDevRunJournalDigestV1,generation,journalStoreGeneration,journalStoreId,runId,version:1}`，只能从authenticated anchor/store head派生，不能由caller填。`selfdev-run-journal-anchor-payload.v1` exact fields是`{anchorVersion,anchoredAtMs,currentCheckpointCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-journal-checkpoint.v1"),currentRunJournalDigest:SelfDevRunJournalDigestV1,generation,journalStoreGeneration,journalStoreId,policyEpoch,previousAnchorPayloadCanonicalDigest:null|CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),previousRunJournalDigest:null|SelfDevRunJournalDigestV1,revocationEpoch,runId,sequence,state,stateVersion,transitionIntentCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),trustEpoch,version:1}`。`SelfDevRunJournalAnchorV1`不是第六种digest或open wrapper；它恰为`InlineAuthorityEnvelopeV1(payload.role="selfdev-run-journal-anchor-payload.v1",keyPurpose="selfdev-journal-anchor")`的nominal alias，receipt/control中每个anchor field只内嵌这一份 exact payload container+signature。Checkpoint payload/envelope按anchor内typed checkpoint digest由`VerificationSourcesV1`取得，不复制进该alias。Checkpoint/anchor必须同run/store/generation，checkpointSequence≤sequence，checkpoint digest指该sequence event，anchor current digest经exact suffix可达且`sequence-checkpointSequence∈[0,32]`，末event state/version相等；genesis或rollover新checkpoint的`checkpoint.anchorVersion`必须等于result anchorVersion，复用checkpoint则其anchorVersion必须小于result且由current monotonic inclusion proof认证。33前必须新checkpoint。Event/anchor/checkpoint分别用三个closed purposes签名。

Anchor predecessor是 closed paired union：genesis恰为 `anchorVersion=1,sequence=0,previousAnchorPayloadCanonicalDigest=null,previousRunJournalDigest=null`；非 genesis两字段都 non-null、`anchorVersion=checked(previous.anchorVersion+1)`、`sequence=checked(previous.sequence+1)`，分别匹配 store已认证 predecessor anchor payload与 prior run-event digest，mixed-null/skip/fork均拒绝。Recovery不递归 replay全部 old anchors：verifier从 protected monotonic store取得 current或指定 historical checkpoint的 exact signed snapshot/inclusion proof，验证 store id/generation、monotonic anchorVersion和 checkpoint bytes，再仅遍历≤32 event predecessor suffix。Previous-anchor fields用于 store CAS/fork证明而非触发无界 DAG traversal。Missing、rollback、fork、wrong run/store generation/head、suffix=33或把 Catalog digest混入均拒绝；Catalog与SelfDev predecessor counter独立且不相加，但两者 bytes/lookup occurrences都进入global budgets。§19a.7 对 endorsement embedded docs 的 JournalDigest禁止只指 Catalog `JournalDigestV1`与泛化摘要；本节 exact signed run anchor/digest是唯一狭义例外。

只有合法改变§18 run state的ENTER_AWAITING、approval、approval-consumption、completion、expiry-failure与ambiguity-failure使用run anchored protocol。Stage/Git只写effect ledger且run head不变；post-terminal reconciliation只写coordination journal且FAILED run不变。

`TransitionCommitWindowV1`恰为三分支且完全由registry从verified state/policy bytes派生，caller不得选择时间：`{kind:"must-commit-by",mustCommitByMs,sourceRole:"acceptance-authority"|"promotion-challenge-and-approval"|"promotion-consumption-authority"|"promotion-completion-authority",version:1}`用于ENTER_AWAITING/APPROVAL/CONSUMPTION/COMPLETION，sourceRole按该顺序一一对应，deadline分别是current acceptance authority ceiling、challenge/approval authority最早expiry、approval+consumer lease+effective promotion deadline最早值、effective promotion deadline；`{kind:"expiry-failure-window",mustCommitByMs,notBeforeExclusiveMs:reservation.expiresAtMs,policyEpoch,version:1}`用于EXPIRED，其中`mustCommitByMs=checked(reservation.expiresAtMs+maxExpiryCleanupLagMs)`；`{kind:"ambiguity-terminal-marker",mustCommitByMs,terminalMarker:PromotionTerminalMarkerV1,version:1}`用于AMBIGUOUS，deadline由current incident policy的bounded recovery ceiling派生且marker必须仍current。负值/overflow、wrong source或failureKind/window组合拒绝。

Primary `TransitionPreparedV1`先以serializable CAS写unique durable `PREPARED`锁。Exact fields为`{actorAuthorization:TransitionActorAuthorizationV1,expectedLocalRunSnapshot:{generation,runId,runJournalAnchorCanonicalDigest:null|CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),state,stateVersion,version:1},finalMaterializationId:"enter-awaiting-v1"|"promotion-approval-v1"|"promotion-consumption-v1"|"promotion-completion-v1"|"promotion-terminal-failure-v1",intentCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),intentId,materializationInputs:TransitionMaterializationInputsV1,preparedAtMs,state:"PREPARED",version:1}`。`TransitionActorAuthorizationV1`恰为：`{humanDecisionCanonicalDigest:CanonicalPayloadDigestV1(role="human-decision.v1"),humanKeyId,humanKeyPurpose:"human-promotion-decision",humanParticipantCanonicalDigest:CanonicalPayloadDigestV1(role="human-participant-binding.v1"),humanSignatureBase64Url,kind:"human-decision",version:1}`，signature strict-decode必须恰64 bytes；`{kind:"approval-consumer-permit",permitCanonicalDigest:CanonicalPayloadDigestV1(role="approval-consumer-permit.v1"),permitId,version:1}`；`{kind:"completion-worker-permit",permitCanonicalDigest:CanonicalPayloadDigestV1(role="completion-worker-permit.v1"),permitId,version:1}`；或`{kind:"orchestrator",authoritySubject:SelfDevOrchestratorAuthoritySubjectV1,version:1}`。

`TransitionMaterializationInputsV1` exact union恰为`{kind:"enter-awaiting",version:1}`；`{approvalContext:EmbeddedCanonicalV1(role="selfdev-approval-context.v1"),awaitingHumanRunJournalAnchor:SelfDevRunJournalAnchorV1,humanDecision:EmbeddedCanonicalV1(role="human-decision.v1"),humanParticipant:EmbeddedCanonicalV1(role="human-participant-binding.v1"),kind:"promotion-approval",safeDisplay:EmbeddedCanonicalV1(role="safe-display.v1"),version:1}`；`{approvedRunJournalAnchor:SelfDevRunJournalAnchorV1,kind:"promotion-consumption",version:1}`；`{kind:"promotion-completion",promotingRunJournalAnchor:SelfDevRunJournalAnchorV1,version:1}`；或`{kind:"promotion-terminal-failure",prePromotingRunJournalAnchor:SelfDevRunJournalAnchorV1,version:1}`。Branch必须与eventKind/finalMaterializationId一一匹配，所有container/anchor typed digests与intent core逐字段相等；unknown/cross-branch bytes拒绝。Actor branch也固定：ENTER_AWAITING/TERMINAL_FAILURE只允许`orchestrator`且authority subject与intent同字段byte-equal；APPROVAL只允许`human-decision`且key/participant/decision digest/signature与approval core逐字段相等；CONSUMPTION只允许`approval-consumer-permit`且permit id/digest等于通过sources取得并由core绑定的exact permit；COMPLETION只允许`completion-worker-permit`且同理。这样HSM在commit前已持有构造final payload所需的全部immutable bytes，result event/checkpoint/anchor以外没有post-commit fetch或signer依赖。PREPARED不预签run event、不含future anchor、不虚报occurredAt。Permit绑定designated participant、leaseId、RunWorkerFence、run/generation/authorized state+version、issued/expiry/epochs，但**不**回指intent；intent单向携permit digest。Commit时从lease/permit ledger读取并原子consume；actor与durable finalizer signer nominally distinct。

Independent AnchorStore按intentId幂等create `{state:"OPEN",openVersion,intentDigest,expectedPriorAnchorCanonicalDigest,version:1}`。`commit(openVersion,intentDigest,commitWindow)`单CAS读取trustedNow：must-commit分支只在`preparedAtMs≤trustedNow≤mustCommitByMs`成功；EXPIRED只在`notBeforeExclusiveMs<trustedNow≤mustCommitByMs`且linearizable absence proof/current pointer仍相等时成功；AMBIGUOUS只在marker+terminalGeneration仍current且`trustedNow≤mustCommitByMs`时成功。过早expiry、missing marker或actor/permit/lease invalid是mutation=0的typed precondition failure；可信时间超过upper bound时OPEN→CANCELLED。Abort/recovery只可CAS同一OPEN→CANCELLED，commit/abort仅一赢；missing从不证明取消，late create/commit不能越过CANCELLED。

成功HSM transaction按唯一顺序materialize并原子持久：run event(`occurredAtMs=trustedNow`)→`SelfDevRunJournalDigestV1`；若genesis或`newSequence-currentCheckpoint.checkpointSequence>32`则签新checkpoint(`checkpointSequence=newSequence,currentRunJournalDigest=newEventDigest`)，否则复用同run/store/generation的current authenticated checkpoint；再签anchor(`anchoredAtMs=trustedNow`,same intent digest/checkpoint/current event)。Genesis ENTER_AWAITING必须同时产生sequence0 checkpoint；sequence33必须先rollover新checkpoint；anchor current event从其checkpoint经0..32 predecessor可达。所有event/checkpoint/anchor/finalizer keys与trust/revocation state在写前preflight。

随后同一HSM transaction从actor-signed immutable core+stored signed anchor确定性materialize branch output。APPROVAL/COMPLETION产生Artifact payload并由purpose=`selfdev-transition-finalizer`、匹配frozen designated durable K0 finalizer participant的store-owned key签exact detached artifact envelope；CONSUMPTION/TERMINAL_FAILURE产生protected canonical control bytes，其authority只来自同transaction已签result anchor对intent digest的承诺加registry deterministic materialization equality，strict schema中没有额外/unknown envelope字段；ENTER_AWAITING不产生output record或receipt。Human/consumer/completion-worker只授权pre-anchor action，finalizer不得冒充他们。ENTER_AWAITING的primary FINALIZED从exact CEB→endorsement containers、run context和stored result anchor纯派生唯一`selfdev-approval-context.v1`，随后构造`SelfDevRunHeadSubjectV1(state="AWAITING_HUMAN",stateVersion=resultStateVersion,runJournalAnchorCanonicalDigest=result anchor digest,approvalContextCanonicalDigest=derived context digest)`并将full context sibling+head原子发布。Context/head不回填intent/event/anchor，因而方向是intent→event→anchor→context→head且无环。Event、checkpoint、anchor、branch-required final payload及仅适用于Artifact branch的detached envelope与OPEN→ANCHORED一起持久；任一required key unavailable/rotated/mismatched/revoked则写anchor前CANCELLED，绝无post-anchor signer依赖。

`ANCHORED`是logical transition commit。Primary PREPARED锁在FINALIZED前阻止任何旧head消费；每个current read、cancel、expiry或child issue遇PREPARED必须先读取exact AnchorStore outcome：OPEN fail-closed，ANCHORED则幂等复制stored event/checkpoint/anchor/final bytes并完成唯一 local head/challenge/permit/reservation/pointer FINALIZED transaction，CANCELLED则发布唯一failure outcome并释放锁。即使wall clock已过，ANCHORED recovery必须finalize；expiry永远输给PREPARED/OPEN/ANCHORED。Response-lost、crash-before/afterOPEN/checkpoint/ANCHORED/local finalize、duplicate recovery和key revoke各boundary均必须证明一个head、一个final payload、无可消费旧state。

Post-CEB `selfdev-approval-context.v1` 是最大 **16 KiB** 的 closed document，由 CEB 打开的 signed endorsement、已存在的 current AWAITING_HUMAN anchor与 run store纯派生；exact fields 为 `{acceptanceReportCanonicalDigest,awaitingHumanRunJournalAnchorCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),catalogEvidenceBindingCanonicalDigest,expectedAwaitingHumanGeneration,expectedAwaitingHumanStateVersion,knownLimitationsCanonicalDigest,participantIdentitySetCanonicalDigest,reviewerIsolationCanonicalDigest,selfDevPromotionPlanCanonicalDigest,selfDevRunContextCanonicalDigest,selfDevVerificationBundleCanonicalDigest,selfDevVerificationContextCanonicalDigest,policyEpoch,revocationEpoch,runId,trustEpoch,version:1}`。Anchor payload exact bytes只在 containing PromotionApprovalReceipt sibling `awaitingHumanRunJournalAnchor`携带一次；context与所有 head/decision/display仅携带该 typed digest。Sibling digests必须从 CEB→endorsement exact containers重算，goal/criteria/budget/repair事实由 `selfDevRunContext` full bytes提供；anchor必须是同 run/generation/state=`AWAITING_HUMAN`/stateVersion 的 current protected anchor。它不含 receipt/challenge/self digest/ref。Goal、budget、generation、context、anchor或repair attempt变化都会产生不同 context，旧 context不得用于新 repair generation。

`SelfDevRunHeadSubjectV1` 是 closed no-ref subject `{approvalContextCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-approval-context.v1"),bundleBindingCanonicalDigest:CanonicalPayloadDigestV1(role="bundle-binding-payload.v1"),candidateRevision,catalogEvidenceBindingCanonicalDigest,generation,policyEpoch,revocationEpoch,runId,runJournalAnchorCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),selfDevPromotionPlanCanonicalDigest,selfDevRunContextCanonicalDigest,state,stateVersion,trustEpoch,version:1}`。所有 digest从 exact CEB/endorsement sibling或 containing parent唯一 anchor payload重算；anchor payload必须与其 state/version/generation byte-equal。`AWAITING_HUMAN`、`APPROVED`、`PROMOTING`和 terminal result都有各自 exact subject，禁止只绑runId或泛化state version。

`PromotionApprovalReceiptV1` 是§18 approval唯一replacement，exact payload fields恰为`{approvalContext:EmbeddedCanonicalV1(role="selfdev-approval-context.v1"),awaitingHumanRunJournalAnchor:SelfDevRunJournalAnchorV1,bundleBindingCanonicalDigest:CanonicalPayloadDigestV1(role="bundle-binding-payload.v1"),capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),catalogEvidenceBindingRef:ArtifactRefV1(role="catalog-evidence-binding.v1"),challengeId,challengeNonce,expectedAwaitingHumanRunHeadSubject:SelfDevRunHeadSubjectV1(state="AWAITING_HUMAN"),expiresAtMs,humanDecision:EmbeddedCanonicalV1(role="human-decision.v1"),humanKeyId,humanKeyPurpose:"human-promotion-decision",humanParticipant:EmbeddedCanonicalV1(role="human-participant-binding.v1"),humanSignatureBase64Url,issuedAtMs,policyEpoch,resultApprovedRunJournalAnchor:SelfDevRunJournalAnchorV1,resultApprovedStateVersion,revocationEpoch,runId,safeDisplay:EmbeddedCanonicalV1(role="safe-display.v1"),selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),transitionIntentCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),trustEpoch,version:1}`。Signature strict-decode恰64 bytes；其preimage是exact humanDecision canonical bytes而不是receipt。Intent不含post anchor；ANCHORED outcome materialize final receipt，pre/post各出现一次，human decision/display/context逐字段绑定pre head/anchor而final K0 envelope另绑定post result。

Approval issue执行上述 PREPARED→anchor-CAS→FINALIZED protocol：PREPARED CAS验证 exact current `AWAITING_HUMAN` head/generation/version/context/anchor/CEB/plan/participants/current epochs与fresh challenge并预留challenge；FINALIZED CAS消费challenge、持久 receipt payload+detached envelope、发布 exact `APPROVED` head/version+1及post anchor。Cancel/stale/request-changes只可与 PREPARED竞争；replay不得产生 receipt而run未 APPROVED或二次消费。CatalogStage/GitPromotion/Completion期间 CandidateHead仍须 current。该 receipt只授权K3 promotion，不授权adoption/enable。

`promotion-approval-consumption.v1` 是最大32 KiB exact protected record `{approvalConsumerAuthoritySubject:ApprovalConsumerAuthoritySubjectV1,approvalConsumerPermitCanonicalDigest:CanonicalPayloadDigestV1(role="approval-consumer-permit.v1"),approvedRunJournalAnchor:SelfDevRunJournalAnchorV1,capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,consumedAtMs,effectivePromotionDeadlineMs,expectedApprovedRunHeadSubject:SelfDevRunHeadSubjectV1(state="APPROVED"),promotionApprovalReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-receipt.v1"),promotionApprovalReceiptRef:ArtifactRefV1(role="promotion-approval-receipt.v1"),promotingRunJournalAnchor:SelfDevRunJournalAnchorV1,reservationId,resultPromotingStateVersion,runId,selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),transitionIntentCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),version:1}`。Consumer subject及其`ApprovalConsumerPermitV1`绑定designated participant、leaseId/RunWorkerFence/generation/expected APPROVED version/expiry并在AnchorStore commit原子consume，与PROMOTING stage permits nominally distinct。Pre/post anchor各一次；ANCHORED outcome materialize final record/reservation，失败mutation=0。

PromotionApproval issuer必须在issue-time重读current promotion policy并以checked arithmetic验证`issuedAtMs≤expiresAtMs`且`expiresAtMs-issuedAtMs≤maxPromotionLifetimeMs`；负值、溢出或policy不允许的lifetime fail closed。Receipt/plan/endorsement绑定issue-time `policyEpoch`，不持久化policy snapshot、额外policy-derived timestamp或未定型duration摘要。`effective-promotion-deadline-v1` exact inputs恰为四个已持久签名时间戳：same plan/CEB/approval/endorsement bytes中的两个effect-plan `leaseDeadlineMs`、PromotionApproval `expiresAtMs`、Endorsement `expiresAtMs`；唯一output是四者minimum。Approval issue与每次Stage/Git/Completion execution都证明plan/endorsement/CEB/approval/receipts的epochs与current相等；epoch tightening使未完成old lineage stale/failed，不能添加第五source或重算更长/短deadline。Reservation expiry必须exact等于derived output。

`CapabilityReservationFenceV1`与§18 `RunWorkerFenceV1` nominally distinct。`ApprovalConsumerAuthoritySubjectV1={authorizedState:"APPROVED",authorizedStateVersion,expiresAtMs,generation,leaseId,runId,runWorkerFence,workerParticipantCanonicalDigest,workerRole:"promotion-approval-consumer",version:1}`；`PromotingWorkerAuthoritySubjectV1`同common fields但`authorizedState="PROMOTING"`且role=`catalog-stage-worker|git-promotion-worker|selfdev-completion-worker`。`SelfDevWorkerAuthoritySubjectV1`恰为这两个closed branches，state/role交叉拒绝。Participant digest从frozen designated record重算。

`approval-consumer-permit.v1` exact payload是`{approvalConsumerAuthoritySubject:ApprovalConsumerAuthoritySubjectV1,capabilityRevision,expectedApprovedRunHeadSubject,issuedAtMs,permitId,promotionApprovalReceiptCanonicalDigest,policyEpoch,revocationEpoch,trustEpoch,version:1}`；`completion-worker-permit.v1` exact payload是`{catalogStageReceiptCanonicalDigest,completionWorkerAuthoritySubject:PromotingWorkerAuthoritySubjectV1(workerRole="selfdev-completion-worker"),effectivePromotionDeadlineMs,expectedPromotingRunHeadSubject,gitPromotionReceiptCanonicalDigest,issuedAtMs,permitId,reservationId,policyEpoch,revocationEpoch,trustEpoch,version:1}`。Permit不含transition intent/future event/anchor digest；intent单向绑定permit typed digest，避免permit↔intent cycle。两者分别用closed purpose=`promotion-approval-consumer`与`selfdev-completion-worker`签InlineAuthorityEnvelope，并由lease store exact-one lookup；`expiresAtMs`来自subject且completion还必须≤effective deadline。Anchor commit按permitId CAS `ISSUED→CONSUMED`并前后重验leaseId/RunWorkerFence/run/generation/stateVersion/participant/epochs；stage/git worker subject不允许替代consumer/completion permit，旧worker不明不得steal/replay。

`CatalogStageReceiptV1` 与 `GitPromotionReceiptV1` 都必须绑定 exact CEB/PromotionApproval refs、promotion-consumption digest、reservationId、`CapabilityReservationFenceV1`、revision/allocation/plan、各自 exact `PromotingWorkerAuthoritySubjectV1`、两个 effect id/`IdempotencyKeyV1`，以及同一 `deadlineRecord:PromotionDeadlineRecordV1`；effective值必须等于其他四字段 min，不存在只带 own deadline 的 Git 缩减形。Stage receipt另含 `state="STAGE_PENDING"`。Git receipt另逐字段记录 `verifiedBaseRef/baseObjectId`、`promotionRef`、`previousRefObjectId=null`、`expectedCommitObjectId`、`actualCommitObjectId`、object format、transaction outcome id、authoritative reflog/transaction evidence `ExternalDigestV1`；base/expected/actual OID 必须与 frozen CommitObjectPlan/RefTransactionPlan byte-equal。

两者shared `PromotionEffectReceiptCommonV1` exact fields恰为`{capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),catalogEvidenceBindingRef:ArtifactRefV1(role="catalog-evidence-binding.v1"),catalogStageEffectId,catalogStageIdempotencyKey:IdempotencyKeyV1,deadlineRecord:PromotionDeadlineRecordV1,gitPromotionEffectId,gitPromotionIdempotencyKey:IdempotencyKeyV1,promotionApprovalConsumptionCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-consumption.v1"),promotionApprovalReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-receipt.v1"),promotionApprovalReceiptRef:ArtifactRefV1(role="promotion-approval-receipt.v1"),reservationId,runId,selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),version:1}`。`CatalogStageReceiptV1`在common外恰加`{catalogStageTransactionEvidence:ExternalDigestV1(namespace="catalog-stage-transaction",algorithm="sha256"),executionPermitSubject:PromotionEffectExecutionPermitSubjectV1(effectKind="catalog-stage"),receiptKind:"catalog-stage",state:"STAGE_PENDING"}`。`GitPromotionReceiptV1`在common外恰加`{actualCommitObjectId:ExternalDigestV1(namespace="git-object"),authoritativeTransactionEvidence:ExternalDigestV1(namespace="git-ref-transaction",algorithm="sha256"),baseObjectId:ExternalDigestV1(namespace="git-object"),executionPermitSubject:PromotionEffectExecutionPermitSubjectV1(effectKind="git-promotion"),expectedCommitObjectId:ExternalDigestV1(namespace="git-object"),objectFormat:"sha1"|"sha256",previousRefObjectId:null,promotionRef:GitFullHeadsRefV1,receiptKind:"git-promotion",transactionOutcomeId,verifiedBaseRef:GitFullHeadsRefV1}`。Unknown/cross-receipt fields拒绝。

`PromotionEffectExecutionPermitSubjectV1` exact fields是`{capabilityReservationFence:CapabilityReservationFenceV1,effectId,effectKind:"catalog-stage"|"git-promotion",expiresAtMs,idempotencyKey:IdempotencyKeyV1,permitId,reservationId,selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),workerAuthoritySubject:PromotingWorkerAuthoritySubjectV1,version:1}`；effectKind catalog-stage只配workerRole catalog-stage-worker并复制stage effect id/key，git同理。`PromotionEffectExecutionPermitLedgerV1` exact fields是`{attemptId:null|EffectAttemptIdV1,issuedAtMs,ledgerRevision,permitSubject:PromotionEffectExecutionPermitSubjectV1,resultEvidence:null|ExternalDigestV1,state:"ISSUED"|"DISPATCHED"|"CONSUMED"|"RECONCILING"|"SUCCEEDED"|"FAILED_DETERMINISTIC"|"AMBIGUOUS"|"RECONCILED_NOT_OCCURRED"|"RECONCILED_OCCURRED_EXACT",version:1}`。ISSUED时attempt/result均null；DISPATCHED/CONSUMED/RECONCILING要求attempt non-null、result null；SUCCEEDED/FAILED_DETERMINISTIC/AMBIGUOUS要求attempt/result non-null。AMBIGUOUS只能经purpose-signed exact reconciliation CAS转到与outcome一一对应的两种RECONCILED terminal state；这两种state保留原attempt/resultEvidence且不能再dispatch，另由same ledger key绑定唯一`EffectReconciliationRecordV1` digest。Result evidence映射恰为catalog-stage/SUCCEEDED→`catalog-stage-transaction`、catalog-stage/FAILED→`catalog-stage-failure`、git/SUCCEEDED→`git-ref-transaction`、git/FAILED→`git-ref-transaction-failure`、任一/AMBIGUOUS→`promotion-effect-ambiguity-marker`，algorithm全部literal sha256；其他namespace拒绝。每次mutation ledgerRevision checked+1。授权、permit consume、OS/Catalog/Git commit前后都重读exact reservation/pointer/CapabilityReservationFence、leaseId/RunWorkerFence、run generation/PROMOTING stateVersion、expiresAt/current epochs；stale/steal/type-swap mutation/effect=0。DISPATCHED后旧runner必须先被revoke/terminated并权威reconcile，证明未发生且ledger原子release后才可由新human run产生新permit；unknown进入AMBIGUOUS，不能worker steal重放。

已存在 promotion ref 只有在同一 effect/`IdempotencyKeyV1` 的 authoritative transaction evidence证明 exact expected OID 时可补记 receipt。Outcome unknown时只能查询 authoritative transaction/ref state：证明 exact success才补记；证明 effect未发生且 operation是 registry标记的 transactional/queryable时才可在 live permit 下继续 same attempt；仍不可判定则进入 `AMBIGUOUS`、不产 receipt并终止旧 lineage/run，禁止盲重放。只有 wrong base、occupied/different target ref、different OID/effect等**已确定** mismatch 才是 deterministic `promotion_conflict`。

`AMBIGUOUS` CAS按lineageKind closed分支。Invocation branch原子置effect AMBIGUOUS、递增grant/activation terminal guard、关闭相关contexts并写outbox；字段中run/reservation forbidden。Promotion branch另锁reservation/pointer/PROMOTING run marker，置AMBIGUOUS_BLOCKED并触发上述anchored `promotion-terminal-failure`使run→FAILED/recovery_failed。所有child issue/dispatch/effect在commit前读同一guard；跨store outbox未ack也先deny。CAS与child issue仅一winner。

Unresolved AMBIGUOUS不走expiry。`EffectReconciliationRecordV1` payload role=`ambiguity-reconciliation.v1`是closed union；common exact fields为`{effectId,effectKind:"broker"|"catalog-stage"|"git-promotion",idempotencyKey,outcome:"PROVEN_NOT_OCCURRED"|"PROVEN_OCCURRED_EXACT",priorLedgerRevision,reconciledAtMs,reconcilerPolicyEpoch,reconcilerRevocationEpoch,reconcilerTrustEpoch,terminalGeneration,version:1}`。Branches恰为：

- broker（`effectKind="broker"`）：`{activationId,authoritativeEvidence:BrokerReconciliationEvidenceV1,authoritativeResult:BrokerReconciledResultV1|null,brokerKind,brokerRequestCanonicalDigest:CanonicalPayloadDigestV1(role="broker-request.v1"),brokerTargetCanonicalDigest:CanonicalPayloadDigestV1(role="broker-target.v1"),grantId,invocationId,operation}`。`BrokerReconciliationEvidenceV1` exact fields为`{algorithm:"sha256",digestHex:lower_hex_64,namespace,version:1}`；namespace由 `(brokerKind,operation)` 唯一映射：workspace-fs→`workspace-fs-reconciliation`、http/request→`http-provider-reconciliation`、process/spawn-and-wait→`process-supervisor-reconciliation`、memory→`memory-store-reconciliation`、ui/request-confirmation→`ui-ledger-reconciliation`、credential-sign/sign-request→`credential-signer-reconciliation`、sealed-blob→`sealed-blob-store-reconciliation`。Operation必须属于§19a.6.3 closed broker/operation pair 表。
- catalog-stage（`effectKind="catalog-stage"`）：`{authoritativeEvidence:ExternalDigestV1(namespace="catalog-stage-transaction",algorithm="sha256"),authoritativeResult:null|{catalogStageReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-receipt.v1"),resultState:"STAGE_PENDING",version:1},capabilityReservationFence:CapabilityReservationFenceV1,catalogStageEffectPlanCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-effect-plan.v1"),reservationId,runWorkerFence:RunWorkerFenceV1}`。
- git-promotion（`effectKind="git-promotion"`）：`{authoritativeEvidence:ExternalDigestV1(namespace="git-ref-transaction",algorithm="sha256"),authoritativeResult:null|{actualCommitObjectId:ExternalDigestV1(namespace="git-object"),resultStatus:"REF_CREATED_EXACT",version:1},baseObjectId:ExternalDigestV1(namespace="git-object"),expectedCommitObjectId:ExternalDigestV1(namespace="git-object"),gitPromotionEffectPlanCanonicalDigest:CanonicalPayloadDigestV1(role="git-promotion-effect-plan.v1"),promotionRef:GitFullHeadsRefV1,reservationId}`；三个Git OID algorithm均由repository objectFormat唯一映射。

`BrokerReconciledResultV1` 是以下 exact closed union：workspace-fs=`{resultKind:"workspace-fs",resultStatus:"COMMITTED_EXACT"|"ABSENT_EXACT",stateIdentity:ExternalDigestV1(namespace="workspace-fs-state",algorithm="sha256"),version:1}`；http=`{providerStatus:"HTTP_2XX"|"HTTP_3XX"|"HTTP_4XX"|"HTTP_5XX"|"TRANSPORT_FAILURE",responseIdentity:ExternalDigestV1(namespace="http-provider-result",algorithm="sha256"),resultKind:"http",version:1}`；process=`{exitClass:"EXITED_ZERO"|"EXITED_NONZERO"|"SIGNALED"|"TIMED_OUT"|"RESOURCE_KILLED",processIdentity:ExternalDigestV1(namespace="process-supervisor-result",algorithm="sha256"),resultKind:"process",version:1}`；memory=`{resultKind:"memory",resultStatus:"READ_EXACT"|"WRITE_COMMITTED"|"DELETE_COMMITTED"|"ABSENT_EXACT",stateIdentity:ExternalDigestV1(namespace="memory-store-state",algorithm="sha256"),version:1}`；ui=`{resultKind:"ui",resultStatus:"CONFIRMED"|"DENIED",stateIdentity:ExternalDigestV1(namespace="ui-ledger-state",algorithm="sha256"),version:1}`；credential-sign=`{resultKind:"credential-sign",resultStatus:"SIGNATURE_RETURNED",stateIdentity:ExternalDigestV1(namespace="credential-signer-result",algorithm="sha256"),version:1}`；sealed-blob=`{resultKind:"sealed-blob",resultStatus:"READ_COMPLETED"|"OUTPUT_SEALED"|"OUTPUT_DESTROYED",stateIdentity:ExternalDigestV1(namespace="sealed-blob-store-state",algorithm="sha256"),version:1}`。Result kind必须与brokerKind/operation一一匹配。

`PROVEN_NOT_OCCURRED`要求`authoritativeResult=null`并由provider的exact evidence证明absence；`PROVEN_OCCURRED_EXACT`要求non-null branch result且与old target/request/idempotency/current provider state逐字段相等。Unknown/cross-branch field、generic digest、wrong namespace/algorithm/status或result nullability全部拒绝。Per-effect reconciliation CAS锁exact AMBIGUOUS ledger revision、terminal marker与record key，写payload+InlineAuthorityEnvelope并把ledger checked+1到`RECONCILED_NOT_OCCURRED`或`RECONCILED_OCCURRED_EXACT`；ordinary broker idempotency ledger使用同名两个terminal states，promotion permit ledger使用上述exact states。CAS只更新该effect/record，绝不能release parent；replay仅在payload/envelope/old+new revision全byte-equal时幂等返回。

`LineageEffectTerminalProofV1`是aggregate release内的closed inline union，共同字段恰为`{effectId,effectKind:"broker"|"catalog-stage"|"git-promotion",expectedLedgerRevision,expectedLedgerState:"ABSENT"|"SUCCEEDED"|"FAILED_DETERMINISTIC"|"RECONCILED_NOT_OCCURRED"|"RECONCILED_OCCURRED_EXACT",terminalGeneration,terminalKind:"NEVER_ISSUED"|"SUCCEEDED"|"FAILED"|"RECONCILED",version:1}`。Branches恰为：

- NEVER_ISSUED不加branch field，且必须`expectedLedgerState="ABSENT",expectedLedgerRevision=0`。
- Broker SUCCEEDED=`{authoritativeBrokerResult:BrokerReconciledResultV1,brokerRequestCanonicalDigest:CanonicalPayloadDigestV1(role="broker-request.v1"),brokerTargetCanonicalDigest:CanonicalPayloadDigestV1(role="broker-target.v1")}`；Catalog SUCCEEDED=`{catalogStageReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-receipt.v1"),resultState:"STAGE_PENDING"}`；Git SUCCEEDED=`{actualCommitObjectId:ExternalDigestV1(namespace="git-object"),gitPromotionReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="git-promotion-receipt.v1"),resultStatus:"REF_CREATED_EXACT"}`。
- Broker FAILED=`{authoritativeFailureEvidence:ExternalDigestV1(namespace="broker-deterministic-failure",algorithm="sha256"),failureCode:"DENIED"|"INVALID_REQUEST"|"PROVIDER_REJECTED"|"RESOURCE_EXHAUSTED"|"EXPIRED"|"REVOKED"}`；Catalog FAILED=`{authoritativeFailureEvidence:ExternalDigestV1(namespace="catalog-stage-failure",algorithm="sha256"),failureCode:"CATALOG_CONFLICT"|"CATALOG_WRITE_FAILED"}`；Git FAILED=`{authoritativeFailureEvidence:ExternalDigestV1(namespace="git-ref-transaction-failure",algorithm="sha256"),failureCode:"PROMOTION_CONFLICT"|"GIT_TRANSACTION_FAILED"}`。
- RECONCILED=`{effectReconciliationCanonicalDigest:CanonicalPayloadDigestV1(role="ambiguity-reconciliation.v1"),outcome:"PROVEN_NOT_OCCURRED"|"PROVEN_OCCURRED_EXACT"}`，outcome必须分别配`expectedLedgerState="RECONCILED_NOT_OCCURRED"|"RECONCILED_OCCURRED_EXACT"`。

TerminalKind/effectKind选择后只允许对应一行的fields；SUCCEEDED必须配`expectedLedgerState="SUCCEEDED"`，FAILED必须配`expectedLedgerState="FAILED_DETERMINISTIC"`，NORMAL success/failure/never-issued sibling不伪造ambiguity record。Git OID algorithm仍由 frozen repository objectFormat唯一映射，cross-kind、wrong state/namespace或extra field拒绝。

`lineage-reconciliation-release.v1` exact common fields是`{effectTerminalProofs:LineageEffectTerminalProofV1[],expectedTerminalGeneration,lineageKind:"invocation"|"promotion",releasedAtMs,version:1}`；Invocation branch在common外恰加`{activationId,grantId,invocationId}`，promotion branch恰加`{capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,reservationId,runId,runWorkerFence:RunWorkerFenceV1}`，cross-branch字段 forbidden。Proofs按effectId排序unique并穷举frozen PermissionSpec或promotion plan的exact effectId set，每项`terminalGeneration`必须等于common expected值，branch ids/fences必须与terminal marker和所有ledger parent lineage逐字段相等。Purpose=`lineage-reconciliation-finalizer`。单一serializable CAS锁parent/reservation/pointer、**全部**effect ledger/receipt/marker/outbox keys并逐proof byte-equal验证current snapshot；broker的RESERVED/CONSUMED/AMBIGUOUS、promotion的ISSUED/DISPATCHED/CONSUMED/RECONCILING/AMBIGUOUS以及任何missing/unrecognized ledger必须全为0，每个effect只可处于proof声明的ABSENT/SUCCEEDED/FAILED_DETERMINISTIC/两种RECONCILED终态。随后才签/persist aggregate release与tamper-evident coordination journal。Ordinary context保持revoked/closed；promotion只把reservation→RELEASED_RECONCILED并clear pointer，FAILED run head/version/anchor保持byte-identical。New human-started lineage必须绑定release digest。Omitted sibling、one-resolved/one-ambiguous或late outcome-vs-release只有一个winner。

这里的coordination journal不是SelfDev state journal：protected append-only `LineageReleaseCoordinationIndexV1` exact record为`{indexRevision,lineageId,lineageKind,previousReleaseCanonicalDigest:null|CanonicalPayloadDigestV1(role="lineage-reconciliation-release.v1"),releaseCanonicalDigest:CanonicalPayloadDigestV1(role="lineage-reconciliation-release.v1"),terminalGeneration,version:1}`，并保存同key下exact release payload+InlineAuthorityEnvelope bytes。Virgin revision=1且previous=null；后续`indexRevision` checked+1并指当前head，fork/rollback/skip拒绝。上述single-store CAS同时写release payload/envelope、index、reservation/pointer/context结果；它不写SelfDev run event、不改变FAILED stateVersion，也不声称与独立run AnchorStore物理原子。

Terminal reconciliation使用`historical-terminal-reconciliation` mode：原lineage按event-time historical bytes验证，同时current reconciler/provider trust/policy/revocation必须live；它可在old deadline/endorsement/epoch后记录outcome/close lineage，但绝不能mint Stage/Git/Completion或恢复old execution。

`reconciled-lineage-dependency.v1`是≤16 KiB protected closed union。Common exact fields为`{effectReconciliationCanonicalDigest:CanonicalPayloadDigestV1(role="ambiguity-reconciliation.v1"),lineageKind:"invocation"|"promotion",lineageReleaseCanonicalDigest:CanonicalPayloadDigestV1(role="lineage-reconciliation-release.v1"),outcome:"PROVEN_NOT_OCCURRED"|"PROVEN_OCCURRED_EXACT",priorEffectId,priorIdempotencyKey,priorLineageId,terminalGeneration,version:1}`；该reconciliation digest必须恰等于release中同priorEffectId的RECONCILED terminal proof且outcome byte-equal；release其余sibling terminal proofs仍全部验证。Broker branch exact fields为`{adapterId:"deny-same-broker-operation-v1",brokerRequestCanonicalDigest:CanonicalPayloadDigestV1(role="broker-request.v1"),brokerTargetCanonicalDigest:CanonicalPayloadDigestV1(role="broker-target.v1"),providerCurrentState:BrokerCurrentStateV1}`；Catalog branch为`{adapterId:"catalog-stage-state-v1",authoritativeCatalogStageState:AuthoritativeCatalogStageStateV1,catalogStageEffectPlanCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-effect-plan.v1")}`；Git branch为`{adapterId:"git-ref-state-v1",authoritativeCurrentRefObjectId:ExternalDigestV1(namespace="git-object"),gitPromotionEffectPlanCanonicalDigest:CanonicalPayloadDigestV1(role="git-promotion-effect-plan.v1"),promotionRef}`。Cross-branch字段forbidden。

`BrokerCurrentStateV1` exact fields为`{brokerKind,operation,stateIdentity:ExternalDigestV1,version:1}`；`(brokerKind,operation,stateIdentity.namespace,stateIdentity.algorithm)`必须恰为：workspace-fs/任一§19a.6.3 workspace operation/`workspace-fs-state`/sha256；http/request/`http-provider-result`/sha256；process/spawn-and-wait/`process-supervisor-result`/sha256；memory/任一memory operation/`memory-store-state`/sha256；ui/request-confirmation/`ui-ledger-state`/sha256；credential-sign/sign-request/`credential-signer-result`/sha256；sealed-blob/任一sealed-blob operation/`sealed-blob-store-state`/sha256。没有 generic namespace或caller-defined adapter。

`AuthoritativeCatalogStageStateV1` exact fields为`{capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),catalogStageReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-receipt.v1"),ledgerRevision,reservationId,reservationState:"AMBIGUOUS_BLOCKED"|"RELEASED_RECONCILED"|"RELEASED_COMPLETED",selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),version:1}`；从current reservation+effect ledger+receipt bytes重算，不接受caller head或不存在的Catalog lifecycle event。

Provider/resource terminal marker存在时，fresh HumanDecision/InvocationDecisionProof+Grant或K3 SelfDevRunContext+PromotionPlan必须携带typed digest；K3 plan/endorsement exact一次内嵌dependency bytes，Invocation使用protected ref，Verifier从signed release+reconciliation payload/envelopes和current provider/Catalog/Git state逐字段重算。无prior marker时必须null。NOT_OCCURRED才可fresh-human重新计划；OCCURRED_EXACT对HTTP/process同target+request永久deny。Catalog/Git只有registered exact adapter证明new plan base/ref/head等于authoritative result后才允许不同semantic next operation。Missing/wrong/cross-lineage dependency或generic adapter拒绝。

`SelfDevCompletionReceiptV1` exact payload fields恰为`{capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,capabilityRevisionAllocationCanonicalDigest:CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),capabilityRevisionAllocationId,catalogEvidenceBindingCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),catalogEvidenceBindingRef:ArtifactRefV1(role="catalog-evidence-binding.v1"),catalogStageReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-stage-receipt.v1"),catalogStageReceiptRef:ArtifactRefV1(role="catalog-stage-receipt.v1"),catalogStageWorkerAuthoritySubject:PromotingWorkerAuthoritySubjectV1(workerRole="catalog-stage-worker"),completedRunJournalAnchor:SelfDevRunJournalAnchorV1,completionWorkerAuthoritySubject:PromotingWorkerAuthoritySubjectV1(workerRole="selfdev-completion-worker"),completionWorkerPermitCanonicalDigest:CanonicalPayloadDigestV1(role="completion-worker-permit.v1"),deadlineRecord:PromotionDeadlineRecordV1,expectedPromotingRunHeadSubject:SelfDevRunHeadSubjectV1(state="PROMOTING"),gitPromotionReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="git-promotion-receipt.v1"),gitPromotionReceiptRef:ArtifactRefV1(role="git-promotion-receipt.v1"),gitPromotionWorkerAuthoritySubject:PromotingWorkerAuthoritySubjectV1(workerRole="git-promotion-worker"),promotingRunJournalAnchor:SelfDevRunJournalAnchorV1,promotionApprovalConsumptionCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-consumption.v1"),promotionApprovalReceiptCanonicalDigest:CanonicalPayloadDigestV1(role="promotion-approval-receipt.v1"),promotionApprovalReceiptRef:ArtifactRefV1(role="promotion-approval-receipt.v1"),reservationId,resultCompletedStateVersion,runId,selfDevPromotionPlanCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),transitionIntentCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),version:1}`。Stage/Git authority subjects必须与其receipt exact bytes相等；completion subject/permit必须与frozen completion-worker participant、lease/RunWorkerFence/version/expiry相等；detached final artifact envelope signer则必须与独立frozen `selfdev-transition-finalizer` participant相等，二者按policy必须different principal/credential/key。AnchorStore只有在trustedNow≤effective deadline且permit current并原子consume时ANCHORED并持久final payload/envelope；FINALIZED只复制exact outcome，同时COMPLETED、RELEASED_COMPLETED、pointer clear。Stale/cross-binding/anchor/finalizer mismatch拒绝。

Expiry与ambiguity terminalization各使用closed `promotion-terminal-failure.v1` protected record `{failureKind:"EXPIRED"|"AMBIGUOUS",failedRunJournalAnchor:SelfDevRunJournalAnchorV1,prePromotingRunJournalAnchor:SelfDevRunJournalAnchorV1,reason:"recovery_failed",reservationId,runId,transitionIntentCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-transition-subject.v1"),version:1}`；pre/post各一次，AnchorStore materialize后run只发生PROMOTING→FAILED。后续reconciliation不得改该record/run anchor/version。

### 19a.9 Catalog adoption、enable 与 lifecycle receipts

#### 19a.9.1 CatalogAdoptionBindingV1

跨 trust/installation domain 采用不得 in-place rewrite CEB/BundleBinding。K0 必须创建：

```text
{
  "adoptionBindingId": <typed id>,
  "capabilityId": <same capability>,
  "catalogEvidenceBindingRef": <exact CEB>,
  "originClass": <same immutable K1/K2/K3>,
  "selfDevCompletionReceiptRef": <required exactly once for K3; absent for K1/K2>,
  "sourceTrustDomain": <unchanged source domain>,
  "targetInstallationDomain": <new typed target domain>,
  "targetPolicyEpoch": <snapshot>,
  "targetTrustEpoch": <snapshot>,
  "version": 1
}
```

`sourceTrustDomain` 与 `targetInstallationDomain` 是两个独立字段，不得在 adoption 后把后者写回前者。CAB绑定 content/trust对象而不自带 Catalog counter；`capabilityRevision` 只进入 candidate/head/event/reservation/plan/receipt state contract，不能用 SemVer/content digest替代。K3 的 CAB 必须验证 matching CompletionReceipt 与同 snapshot `STAGED_DISABLED` 纯投影；K1/K2 如出现 completion ref 必须拒绝。

#### 19a.9.2 Separate human receipts

Catalog state 不使用一个会被新 candidate 覆盖的“capability head”。三种 nominal head 为：`CandidateHeadV1={capabilityId,capabilityRevision,capabilityRevisionAllocationId,capabilityRevisionAllocationCanonicalDigest,candidateId,candidateRevision,phase,eventDigest,version}`，key 是 `(capabilityId,candidateId)`；`InstallationRecordHeadV1={capabilityId,capabilityRevision,capabilityRevisionAllocationId,capabilityRevisionAllocationCanonicalDigest,targetInstallationDomain,catalogAdoptionBindingRef,recordRevision,state,eventDigest,version}`，key 再含 CAB；`ActivationSlotHeadV1={capabilityId,capabilityRevision,capabilityRevisionAllocationId|null,capabilityRevisionAllocationCanonicalDigest|null,targetInstallationDomain,slotRevision,activeCatalogAdoptionBindingRef|null,activeCatalogEvidenceBindingRef|null,eventDigest|null,version}`，key 是 capability+target。Virgin slot 唯一合法空形是 `capabilityRevision=0, slotRevision=0, allocationId=null, allocationDigest=null, eventDigest=null, active refs=null`；任何经 DISABLED/QUARANTINED/REMOVED/REVOKED 清空的 post-event slot仍保留该 clearing event 的 exact nonzero revision、non-null allocation id/digest 和 event digest，只有 active refs 为 null；active slot的 revision/allocation id/digest必须与 active record相同。所有 allocation digest 的 literal role 均为 `capability-revision-allocation-record.v1`。`capabilityRevision` 是 reducer按 capability全局 CAS分配的 strictly increasing safe integer，标识一次 immutable lifecycle attempt。

下列 no-ref subject 是 registry 生成的 exact closed types，不是一个可任意删字段的“摘要”：`CandidateHeadSubjectV1` 逐字段复制 `CandidateHeadV1`（该 head 本身无 ArtifactRef）；`InstallationRecordHeadSubjectV1` 复制除 `catalogAdoptionBindingRef` 外的所有字段，并在同一 field path 以从 ref bytes重算的 `catalogAdoptionBindingCanonicalDigest` 替换；`ActivationSlotHeadSubjectV1` 复制除两个 optional active refs 外的所有字段，并用同 null/present cardinality 的 CAB/CEB role-typed canonical digests替换。三者都保留 exact `eventDigest`/revision/allocation/record-or-slot revision/state；unknown field、丢字段或只比较其中的 digest 都拒绝。

`recordRevision`、`slotRevision`、`capabilityRevision`和 Catalog event `sequence` 是四种不可互换的 nominal counters。新 InstallationRecord 唯一 initial `recordRevision=1`；任何已有 record mutation 的 result必须 `recordRevision=checked(expected.recordRevision+1)`。Virgin slot 为0；每个改变 active-ref pair 或 clearing metadata的 event 必须 `slotRevision=checked(expected.slotRevision+1)`，不改 slot的 event则逐字段复制 exact slot/revision。同一 ENABLED swap 中 target/prior records各自从自己 expected revision checked +1，slot只 +1。Overflow、skip、reuse、ABA（内容回到旧值但 revision 未增）或用 capabilityRevision 替代 local revision 都拒绝。

Allocator 与 allocation proof 的 machine contract 是：

```text
CapabilityRevisionAllocatorV1 = {
  capabilityId, highWatermark, version: 1
}

CapabilityRevisionAllocationRecordV1 =
  | {
      allocationId, allocationKind: "candidate-discovery",
      allocatorExpectedHighWatermark, capabilityId, capabilityRevision,
      candidateId, candidateRevision: ExternalDigestV1,
      catalogAdoptionBindingCanonicalDigest: null,
      catalogEvidenceBindingCanonicalDigest: null,
      createdAtMs, expectedActivationSlotHeadSubject: null,
      expectedCandidateHeadSubject: null,
      expectedInstallationRecordHeadSubject: null,
      expiresAtMs: null, policyEpoch, reason: "candidate-discovery",
      revocationEpoch, targetInstallationDomain: null, trustEpoch, version: 1
    }
  | {
      allocationId, allocationKind: "restore-enable",
      allocatorExpectedHighWatermark, capabilityId, capabilityRevision,
      candidateId: null, candidateRevision: null,
      catalogAdoptionBindingCanonicalDigest:
        CanonicalPayloadDigestV1(role="catalog-adoption-binding.v1"),
      catalogEvidenceBindingCanonicalDigest:
        CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),
      createdAtMs,
      expectedActivationSlotHeadSubject: ActivationSlotHeadSubjectV1,
      expectedCandidateHeadSubject: null,
      expectedInstallationRecordHeadSubject: InstallationRecordHeadSubjectV1(
        state="DISABLED"
      ),
      expiresAtMs,
      policyEpoch,
      reason: "re-enable-disabled" | "restore-prior",
      revocationEpoch, targetInstallationDomain, trustEpoch, version: 1
    }

CapabilityRevisionAllocationLedgerEntryV1 = {
  allocationRecordCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  capabilityId, capabilityRevision,
  state: "CONSUMED_DISCOVERED" | "ALLOCATED_RESTORE" |
         "CONSUMED_ENABLED" | "EXPIRED_RESTORE",
  version: 1
}
```

`allocationId` 是独立 bounded ASCII nominal id，wire parent字段名统一为 `capabilityRevisionAllocationId`并必须 byte-equal record `allocationId`。Record key 是 `(capabilityId,capabilityRevision)`，同 capability 的 `allocationId` 也必须唯一；ledger entry 只能指向该 key 下不可变 record exact bytes重算得到的 typed digest。No-history 时 `allocatorExpectedHighWatermark=0, capabilityRevision=1`；其余必须 `capabilityRevision=checked(allocatorExpectedHighWatermark+1)`且 expected 必须 field-equal locked allocator current high-watermark。同一 serializable CAS 锁 allocator + allocation key，再原子写 immutable record/ledger 并将 allocator 推进到新 revision；duplicate key/id、overflow或 concurrent winner后的 stale expected 全拒绝。Record 不含自己 digest；typed digest只放在 ledger/head/receipt/event/plan sibling，所以无 self-cycle。

Restore branch 的 source/reason 是不相交 closed union：`re-enable-disabled` 要求 source record=`DISABLED`且 target exact CAB/generation等于`CapabilityActivationHistorySubjectV1`的last-active authority；`restore-prior`要求 source record=`DISABLED`且 target是另一个`AcceptedCapabilityAuthorityIndexV1` successful-enabled generation，不论current slot active或post-event empty。两者content必须匹配global `AcceptedCapabilityContentIndexV1`，authority generation必须current verified/non-revoked。Never-enabled `INSTALLED_DISABLED` 只有其candidate allocation仍是allocator current high-watermark时可走initial；allocator前进后不能伪装restore/direct enable，必须fresh DISCOVERED/adoption。CAB/CEB/version/Binding/generation从source closure+history/index重算；reason/mode label不由slot nullability决定。Cross-label、same-version Binding substitution或用new allocation包装stale never-active record均拒绝。

Restore allocation 还必须在 issue-time 重读 current policy，用 checked arithmetic证明 `createdAtMs <= expiresAtMs` 且 `expiresAtMs-createdAtMs <= maxRestoreAllocationLifetimeMs`，并绑定 current policy/trust/revocation epochs。EnableApproval 必须 `allocation.createdAtMs <= issuedAtMs <= approval.expiresAtMs <= allocation.expiresAtMs`；ENABLED consume 时 `nowMs` 必须同时不晚于 approval 和 allocation expiry，且 epochs仍 current。Expiry/epoch drift 只能将 ledger `ALLOCATED_RESTORE→EXPIRED_RESTORE`，不回退 allocator、不复用 revision，也不用 current policy 改写 persisted expiry。

Candidate branch的 allocation + `DISCOVERED` event payload/detached authority envelope/journal append/head create是一个 transaction，ledger直接写 `CONSUMED_DISCOVERED`；crash 后只能从同一 authoritative transaction log证明全部同时成功或同时未发生，不得私自补一个无 allocation 的 discovered head。Restore branch在 human prompt 前写 `ALLOCATED_RESTORE`，record必须绑定 source record/slot no-ref subjects、exact CAB/CEB digests、target/reason/epochs/expiry；EnableApproval 和 ENABLED event 逐字段绑定 allocation id/digest/revision。ENABLED event payload + exact detached authority envelope + journal append/head swap与 ledger `ALLOCATED_RESTORE→CONSUMED_ENABLED`在同一 CAS；超时只能转 `EXPIRED_RESTORE`，不推退 allocator、不复用 revision。

BUNDLE_VERIFIED、APPROVAL_REQUIRED、plan、reservation、receipts以及同 attempt后续 events只能逐字段复制已分配 value + allocation typed digest，并从 Catalog allocation store重读 exact record，**不得再次计算 next**；stale/missing/mismatched allocation、已有同 revision reservation history或 revision不大于 last completed/superseded attempt时不得创建 reservation。Revision allocation只保留并发/fencing identity，不证明 bundle verified、approved、installed或可 activation；lifecycle仍必须逐 gate推进。`candidateRevision` 是 content identity，`capabilityVersion` 是 SemVer，三者 nominally different。新 v2 candidate/installed-disabled record 可以与仍 ENABLED 的 v1 slot side-by-side 存在；slot切换到新/rollback record时记录该 attempt的 capabilityRevision/allocation digest，绝不把计数器倒退成旧 bundle原 revision。

Inline head/projection 的 ArtifactRef path是 closed，且每个 actual occurrence（即使重复同一 ref）都计 named cardinality、closure occurrence/depth；unique fetched bytes才可在 byte budget去重：

| Inline type | ArtifactRef paths | Cross-field invariant |
|---|---|---|
| `CandidateHeadV1` / `CandidateStateProjectionV1` | 0 | projection恰为 head去掉 `eventDigest`；allocation digest按 key重读 candidate-discovery record |
| `InstallationRecordHeadV1` / `InstallationRecordStateProjectionV1` | `catalogAdoptionBindingRef`: exactly 1 | projection恰为 head去掉 `eventDigest`；ref必须是该 target/record的 CAB，allocation digest必须是当次 install/restore attempt |
| `ActivationSlotHeadV1` / `ActivationSlotStateProjectionV1` | `activeCatalogAdoptionBindingRef`: 0..1; `activeCatalogEvidenceBindingRef`: 0..1 | 两者必须同 null或同 present；present时 CAB→CEB byte-equal且 target/capability一致，allocation id/digest/revision等于 active record；null pair必须是 virgin-zero/null 或保留 clearing event revision/allocation id/digest的 post-event empty union；projection恰为 head去掉 `eventDigest` |

Receipt/Event registry必须把每个出现上述 inline type的完整 field path展开，不得只计 root direct refs。Expected head在 issue和consume时必须与 current materialized store field-equal；event result projection中 target record/slot refs必须与该 transition顶层 target CEB/CAB refs byte-equal，旧 active slot/prior record refs则必须彼此形成同一 prior CAB→CEB closure。Mixed-null slot、wrong target、head/projection substitution或漏计 nested occurrence都拒绝。

`AdoptionApprovalReceiptV1` 只批准 exact CAB + target installation domain + `INSTALLED_DISABLED` record create intent，并绑定 authenticated actor、`challengeId:ChallengeIdV1`、`challengeNonce:HumanChallengeNonceV1`、exact `capabilityRevision/capabilityRevisionAllocationId`、`capabilityRevisionAllocationCanonicalDigest: CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1")`、`safeDisplay: EmbeddedCanonicalV1(role="safe-display.v1")`、`expectedCandidateHead: CandidateHeadV1(phase="APPROVAL_REQUIRED")`、`expectedInstallationRecordHead:null`、`observedActivationSlotHead: ActivationSlotHeadV1`、epochs/expiry；SafeDisplay bytes 从 CAB/CEB permission projection、当前 active slot和 typed write intent确定性重建。Candidate capability/content revision、allocation bytes/id/digest或 record/slot任一不再 field-equal时 receipt stale。

`CanonicalSemVerV1` 是1..64 ASCII bytes的nominal string，严格使用SemVer 2 grammar：`major.minor.patch[-prerelease][+build]`，core numeric identifier非空且0以外无leading zero；prerelease/build均为dot-separated `[0-9A-Za-z-]+`，prerelease纯数字identifier同样无leading zero，empty identifier、`v` prefix、range或normalization全部拒绝。Canonical parser必须按原bytes重序列化byte-equal。`CanonicalSemVerPrecedenceV1` exact object是`{majorDigits,minorDigits,patchDigits,preRelease:SemVerPreReleaseIdentifierV1[],version:1}`，三个core digit strings都满足同一canonical numeric grammar；`SemVerPreReleaseIdentifierV1`恰为`{digits,kind:"numeric",version:1}`或`{kind:"text",value,version:1}`，text必须匹配`[0-9A-Za-z-]+`且含至少一个非digit。`preRelease=[]`当且仅当full version没有prerelease；否则数组按原identifier顺序且总bytes仍受64-byte root约束。Precedence object完全排除build metadata；数字比较禁止JS Number，先比digit byte length再unsigned ASCII lex。Prerelease按SemVer规则：无prerelease较高，逐identifier比较；numeric<nonnumeric，numeric按length+lex，text按ASCII lex，公共prefix相同则更长list较高。Build-only差异precedence相等。

所有parent wire只允许字段`targetFullCanonicalVersion:CanonicalSemVerV1`，任何别名字段都按unknown field拒绝。`CapabilityVersionWatermarkSubjectV1` 是 no-ref exact projection `{capabilityId,eventDigest,highestNormalEnabledPrecedence:null|CanonicalSemVerPrecedenceV1,targetInstallationDomain,watermarkRevision,version:1}`；normal-upgrade proposed subject替换为target precedence、revision checked+1且eventDigest=null，其他mode proposed必须byte-equal expected。

`CapabilityActivationHistorySubjectV1` 是slot即使active=null也保留的non-authority exact projection：virgin `{lastActiveAcceptedContentKey:null,lastActiveAuthorityGeneration:null,lastActiveBundleBindingCanonicalDigest:null,lastActiveCatalogAdoptionBindingCanonicalDigest:null,lastActiveEventDigest:null,lastActiveFullCanonicalVersion:null,historyRevision:0,version:1}`；non-virgin六个lastActive字段全non-null并来自immutable ENABLED/clearing event，`historyRevision`每次active target变化checked+1。Clearing event必须从pre-slot exact active CAB→CEB→Binding和ENABLED event重算这些fields，caller不能用empty slot猜label。

`EnableApprovalReceiptV1`引用 exact CAB/AdoptionApproval并绑定 actor/challenge、`enableMode:"initial"|"restore"`、`versionTransitionMode:"normal-upgrade"|"reenable"|"rollback"|"authority-refresh"`、`targetFullCanonicalVersion`、target precedence、Binding、target/previous `authorityGeneration`、`expectedActivationHistorySubject`、`proposedActivationHistorySubject`、expected/proposed watermark、current result revision/allocation、expected record/slot、exact contribution/permission/profile/probe、SafeDisplay、epochs及issued/expiry。HumanDecision、SafeDisplaySubject/Projection、receipt与CatalogEvent逐字段相同，reducer不得在approval后选择mode/version/binding/generation/history/watermark result。

Mode由verified history/index唯一派生：无target-domain history且target precedence>virgin watermark，或有history且target precedence严格高于watermark，是`normal-upgrade`；target与last-active content/version/Binding/CAB/authorityGeneration全部相同是`reenable`；target与last-active content/version/Binding相同但是same Binding的fresh greater authorityGeneration是`authority-refresh`；target为global accepted-content index中另一个曾successful ENABLED content（通常older）是`rollback`。Overlap按该顺序不允许：same content new generation只能authority-refresh，different accepted content只能rollback。Build-metadata-only差异不提高precedence。

`enableMode="initial"`要求expected record=`INSTALLED_DISABLED`且它是current allocator high-watermark的fresh adoption；可配normal-upgrade、authority-refresh，或为older accepted content创建fresh current authority generation时配rollback。Allocator已有higher attempt的never-enabled stale record不得direct enable/restore，必须重新DISCOVERED/adopt。`enableMode="restore"`要求expected record=`DISABLED`、fresh restore allocation且target exact successful-enabled generation仍current-live；只可配reenable或rollback。Expired/revoked generation不能restore：必须同Binding/version重新verification→fresh CEB/CAB authorityGeneration、fresh adoption，再initial authority-refresh（same last content）或initial rollback（older content）。Normal-upgrade推进watermark；reenable/rollback/authority-refresh保持expected/proposed watermark byte-equal。非法cross-product、stale history/watermark/index、same version不同Binding、generation不单调，或四个 mode 无一命中（无法由 verified history/index 唯一派生）均拒绝。Enable无invocation input/PermissionSpec；SafeDisplay完整展示mode/version/Binding/old+new generation/history/watermark/revision/allocation/permission/effect/resource和slot/record swap。

所有 closure/authority verifier都必须接收 exact `VerificationTemporalContextV1`，禁止 implicit now、caller 裸传 `asOfMs` 或用 wall clock 猜历史时间。该 closed union 恰为：

```text
CurrentAuthorityTemporalContextV1 = {
  mode:"current-authority", currentPolicyEpoch, currentRevocationEpoch,
  currentTrustEpoch, trustedNowMs, version:1
}
HistoricalAsOfTemporalContextV1 = {
  mode:"historical-as-of",
  authenticatedUseSource:AuthenticatedUseSourceV1,
  currentRevocationHead:MonotonicRevocationHeadV1, version:1
}
HistoricalTerminalReconciliationTemporalContextV1 = {
  mode:"historical-terminal-reconciliation",
  originalUse:HistoricalAsOfTemporalContextV1,
  currentPolicyEpoch, currentProviderEpoch, currentReconcilerTrustEpoch,
  currentRevocationEpoch, trustedNowMs, version:1
}
```

`AuthenticatedUseSourceV1` 是 exact closed union：endorsement=`{sourceKind:"endorsement",useRole:"catalog-verification-endorsement.v1",endorsementCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-verification-endorsement.v1"),endorsementRef:ArtifactRefV1(role="catalog-verification-endorsement.v1"),version:1}`；Catalog=`{catalogEventCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-event.v1"),catalogEventJournalDigest:JournalDigestV1,catalogEventRef:ArtifactRefV1(role="catalog-event.v1"),sourceKind:"catalog-event",useRole:"adoption-approval-receipt.v1"|"enable-approval-receipt.v1"|"catalog-event.v1",version:1}`；SelfDev=`{runJournalAnchorCanonicalDigest:CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1"),runJournalEventDigest:SelfDevRunJournalDigestV1,sourceKind:"selfdev-anchor",useRole:"promotion-approval-receipt.v1"|"selfdev-completion-receipt.v1",version:1}`。Verifier必须通过`VerificationSourcesV1`取得对应 exact payload/envelope/checkpoint/inclusion bytes；wire没有`asOfMs`字段。`MonotonicRevocationHeadV1` exact fields为`{headDigest:ExternalDigestV1(namespace="revocation-registry-head",algorithm="sha256"),highestRevocationEpoch,registryGeneration,version:1}`，必须从current protected registry读取，caller副本不构成authority。

Registry 按被验证 role 唯一派生 authenticated `asOfMs`：Endorsement 自身使用其 `verifiedAtMs`；PromotionApproval 使用 AWAITING_HUMAN→APPROVED run event/anchor 的 `occurredAtMs==anchoredAtMs`，并要求 receipt `issuedAtMs≤asOfMs≤expiresAtMs`；AdoptionApproval/EnableApproval 使用消费它的 `CatalogEvent.occurredAtMs`；Completion 使用 PROMOTING→COMPLETED run event/anchor 的 `occurredAtMs==anchoredAtMs`；CatalogEvent 使用自身 `occurredAtMs`。不存在 generic `receipt.occurredAtMs`。Authenticated source 的 role/digest/run或catalog sequence/head/inclusion proof不匹配即拒绝。

Historical verifier先从 append-only policy/trust/key history证明签发/使用时 `issuedAtMs≤asOfMs≤expiresAtMs`、event-time epochs与key有效且single-use authority已由matching event消费；再强制读取**当前单调 revocation head**。`RevocationRecordV1` exact fields是 `{invalidFromMs,keyOrIdentityId,mode:"prospective"|"retroactive",recordVersion,revocationEpoch,scope:"key"|"credential"|"principal"|"authority-lineage",version:1}`：prospective 只使 `asOfMs≥invalidFromMs` 的使用无效；retroactive 使该scope下所有受影响历史使用无效。Natural TTL后来过去不抹掉已提交 provenance，但current-head回滚/分叉、覆盖event-time的revocation、缺历史snapshot/inclusion proof全部拒绝或隔离；historical proof永不能mint fresh authority。

Current-authority mode显式使用 `trustedNowMs`，adoption/enable transition消费、Activation/Invocation/Broker issuance与effect dispatch都重查 current policy/trust/revocation epochs和 current endorsement/runtime authority。Human receipt expiry只是一笔 transition 的single-use消费窗口：Catalog/run event提交后按上述authenticated event time作历史验证，不成为长期runtime lease。Endorsement expiry是 runtime authority ceiling；InstallationRecord/ActivationSlot materialized projection绑定`authorityExpiresAtMs`，任一token/context expiry不得超过它。超过后Rust立即deny、new token=0，Catalog reducer以一个serializable CAS写现有closed `QUARANTINED` transition且reason code literal=`AUTHORITY_EXPIRED`、递增terminal guard并清active slot；它与enable/disable只能一个winner。

因此 adoption event consume时 AdoptionApproval与endorsement都必须current-live；enable可把matching successful adoption event按historical-as-of作为provenance，但fresh EnableApproval与目标authority generation的endorsement必须current-live。Endorsement expiry后V1无in-place续签：旧active context先fail-closed quarantine，随后对同一content重新verification产生fresh endorsement→CEB→CAB authority generation，再fresh adoption/enable；旧对象只保留historical provenance。Terminal reconciliation可晚于old deadline/endorsement/epoch，仅按original historical source + current reconciler/provider/trust/revocation authority记录结果并关闭lineage，绝不能恢复old execution或mint Stage/Git/Completion。

Promotion、adoption、enable 三种 receipt 有不同 schema role、domain、key purpose 和决策字段，永不可互相复用或继承。Upgrade、permission/template/tier/probe/CEB/CAB、对应 candidate/record/slot head或 epoch 任一变化都需要新 receipt；无关 candidate/global event不改变 installation/slot head，因而不会制造伪冲突。

Human receipt/InvocationDecisionProof 的 `actorId` 都不是自证身份。每个 human-authorized parent必须另含 `humanParticipant: EmbeddedCanonicalV1(role="human-participant-binding.v1")`、`humanDecision: EmbeddedCanonicalV1(role="human-decision.v1")` 和 actor key 的 detached `humanSignatureBase64Url`。Participant bytes固定 actor id、run role、purpose domain、participation state、exact embedded `principal-binding.v1`/`credential-binding.v1` containers（含 issuer-authenticated `principalSubjectCommitment`/`opaqueCredentialCommitment`）、human key fingerprint/purpose、session/context/challenge-issuer identity、registry epoch/validity；其 record必须 byte-equal frozen ParticipantIdentitySet designated role或在 receipt issue时由 current registry按同 schema新增。Reissued id/null key不能改变 equality/independence结果。

`human-decision.v1` 是一个 exact four-variant tagged union。每个 variant只允许 common fields加本分支 fields；其他分支字段与 unknown fields全部 forbidden：

```text
common = {
  actorId, challengeId, challengeNonce:HumanChallengeNonceV1, decision:"approve",
  decisionKind:"promotion"|"adoption"|"enable"|"invocation",
  decisionNonce:DecisionNonceV1, expiresAtMs, issuedAtMs, policyEpoch, revocationEpoch,
  safeDisplayCanonicalDigest:CanonicalPayloadDigestV1(role="safe-display.v1"),
  trustEpoch, version:1
}
promotion = common + {
  capabilityRevision, capabilityRevisionAllocationId,
  capabilityRevisionAllocationCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  expectedCandidateHeadSubject,
  catalogEvidenceBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),
  expectedSelfDevRunHeadSubject:SelfDevRunHeadSubjectV1(state="AWAITING_HUMAN"),
  selfDevApprovalContextCanonicalDigest:
    CanonicalPayloadDigestV1(role="selfdev-approval-context.v1"),
  selfDevPromotionPlanCanonicalDigest:
    CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),
  selfDevRunJournalAnchorCanonicalDigest:
    CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1")
}
adoption = common + {
  capabilityRevision, capabilityRevisionAllocationId,
  capabilityRevisionAllocationCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  catalogAdoptionBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-adoption-binding.v1"),
  expectedCandidateHeadSubject, expectedInstallationRecordHeadSubject:null,
  observedActivationSlotHeadSubject, targetInstallationDomain
}
enable = common + {
  capabilityRevision, capabilityRevisionAllocationId,
  capabilityRevisionAllocationCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  enableMode:"initial"|"restore",
  versionTransitionMode:"normal-upgrade"|"reenable"|"rollback"|"authority-refresh",
  catalogAdoptionBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-adoption-binding.v1"),
  catalogPermissionProjectionCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-permission-projection.v1"),
  expectedActivationHistorySubject, expectedActivationSlotHeadSubject,
  expectedInstallationRecordHeadSubject,
  expectedVersionWatermarkSubject, proposedVersionWatermarkSubject,
  previousAuthorityGeneration, proposedActivationHistorySubject,
  targetAuthorityGeneration, targetBundleBindingCanonicalDigest,
  targetFullCanonicalVersion, targetSemVerPrecedence
}
invocation = common + {
  activationId,
  activationPayloadCanonicalDigest:
    CanonicalPayloadDigestV1(role="activation-token-payload.v1"),
  activationSlotHeadSubject,
  catalogEvidenceBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),
  effectivePolicyCanonicalDigest:
    CanonicalPayloadDigestV1(role="effective-policy-snapshot.v1"),
  inputCanonicalDigest:CanonicalPayloadDigestV1(role="invocation-input.v1"),
  installationRecordHeadSubject, invocationId,
  permissionSpecCanonicalDigest:
    CanonicalPayloadDigestV1(role="permission-spec.v1"),
  principalCanonicalDigest:
    CanonicalPayloadDigestV1(role="principal-descriptor.v1"),
  reconciledLineageDependencyCanonicalDigest:
    null|CanonicalPayloadDigestV1(role="reconciled-lineage-dependency.v1"),
  safeDisplayDecisionMappingCanonicalDigest:
    null|CanonicalPayloadDigestV1(role="safe-display-decision-mapping.v1")
}
```

Head subject使用 closed no-ref projection：CandidateHead无 ref字段并原样复制；InstallationRecordHead的 CAB ref替换为 `catalogAdoptionBindingCanonicalDigest`；ActivationSlotHead的 optional CAB/CEB refs分别替换为 literal role=`catalog-adoption-binding.v1`/`catalog-evidence-binding.v1` 的 optional CanonicalPayloadDigest，其他字段原样复制。每个 digest必须从 containing parent顶层或 sibling head ref fetch的 exact canonical bytes重算；`human-decision.v1` 和 `safe-display.v1` 内不得出现任何 ArtifactRef、CanonicalObjectRef、AuthorityContextRef或 opaque handle。

四个human分支共享不可覆盖 invariant：`humanDecision.decisionNonce == siblingSafeDisplay.decisionNonce`，`humanDecision.safeDisplayCanonicalDigest`必须从该唯一sibling SafeDisplay exact bytes按role重算；`challengeNonce`是独立nominal challenge值，不能替代decision nonce。Promotion/adoption/enable SafeDisplay subject的`principalId`只能从 enclosing `HumanParticipantBindingV1.principalBinding` exact bytes派生，并与decision actor及receipt participant byte-equal；invocation subject的`principalId`从同一verified `principal-descriptor.v1`派生，human actor仍独立由HumanParticipant验证。Caller supplied principal、nonce、display digest或branch-specific copy没有authority。四分支任一nonce/principal/display cross-swap都拒绝。

Promotion variant的 CEB/plan/context/run-head/anchor fields必须与 enclosing PromotionApprovalReceipt、SafeDisplay subject及唯一 sibling anchor payload逐字段 byte-equal；anchor digest从该payload重算，head中的anchor/context digests不得另给。Adoption/enable variant的CAB/Binding/revision/allocation/head/history/watermark/mode字段必须与其receipt和SafeDisplay逐字段相等。Invocation variant 的全部 fields必须与 enclosing `InvocationDecisionProofV1` common fields及其 `human` branch逐字段 byte-equal：head subject由 proof exact InstallationRecord/ActivationSlot heads确定性投影，human branch的 challenge id/nonce以及 common issued/expiry、epochs、activation/invocation/principal/input/spec/policy/display/mapping/CEB/dependency digests全部相同。SafeDisplay invocation subject中 activation/invocation/CEB/spec ids/digests与 epochs必须和这些 fields byte-equal。无 secret时 mapping digest必须 null，有 secret时必须 non-null并等于 mapping A bytes的 typed digest；receipt-only head/plan/CAB字段在 invocation分支 forbidden。Verifier重读 current trust registry exact bytes并按 distinct human key在 role-separated decision bytes上验签，要求 actor/participant/bindings/decision/parent fields byte-equal；branch substitution、任一 digest/head/nonce/expiry drift或跨 invocation replay都拒绝。

Promotion human participant必须等于 endorsement frozen set中 designated promotion approver；Adoption/Enable在 issue时各自冻结 current human binding。K3 human必须与 model Developer/Reviewer、runner/generator/endorser/worker及 frozen forbidden participants在 actor/principal/credential/key/session/context与两个 stable commitment维度满足 base separation policy；换发 id、另开 session或 null public key不能绕过。K1/K2 是否禁止 author/publisher本人批准、以及 promotion/adoption/enable是否要求不同 human，由不可放宽的 base separation-of-duties policy决定，不在 ABI 硬编码多人。即使同一授权 human依次决策，三种 decision/challenge/session/signature/receipt/domain都必须 fresh且不能复用旧 proof。Adoption/Enable的challenge unseen/current-head/current-registry检查、challenge consume、receipt payload+authority envelope与Catalog state transition必须在各自同一serializable Catalog CAS；Promotion则唯一使用§19a.8.2 anchored protocol：PREPARED原子reserve challenge并阻塞竞态，ANCHORED持久exact receipt payload/envelope，primary FINALIZED CAS才consume challenge并发布APPROVED head，任何reader在gap内fail closed。K0 finalizer不能用自己的authority key伪装human actor，任何 actor/subject/head/revision/expiry drift都要新 challenge/receipt。

#### 19a.9.3 CatalogEventV1

Catalog event 是 append-only authority payload。每个 event 都含 global audit chain 的 `catalogId`、`sequence`、`previousEventDigest: JournalDigestV1 | null`、typed `capabilityRevision`、`capabilityRevisionAllocationId`、`capabilityRevisionAllocationCanonicalDigest: CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1")`、`transition`、`policy/trust/revocationEpoch`、`occurredAtMs`，并携带 transition-specific **expected heads**与 **result state projections**。Expected head可含 prior event digest；`CandidateStateProjectionV1`、`InstallationRecordStateProjectionV1`、`ActivationSlotStateProjectionV1`只含新业务字段/revision/allocation id+digest，明确没有 `eventDigest`。同一 candidate/install attempt的 events与 receipts沿用一个 revision/allocation pair；只有通过 per-capability CAS开始 later attempt时才分配严格更大的 revision。Finalize event canonical bytes后才计算 new `JournalDigestV1`，reducer在同一 transaction把它附到 projection并派生/store新 HeadV1；event payload绝不能含自己的 digest/ref。Receipt只绑定它将 CAS 的 exact expected heads，不绑定易被其他 candidate/capability event推进的 global journal head；global epochs变化仍会按 policy使 receipt stale。

Transition-specific fields 是 closed union：

| `transition` | 额外必须字段 | 必须缺省字段 |
|---|---|---|
| `DISCOVERED` | expected candidate head=null；new CAS-allocated capabilityRevision + allocation id/digest、candidate id/content revision/source kind/external digest；result head phase=DISCOVERED；无 ArtifactRef；allocation + event + head同一 transaction | Binding/CEB/CAB、全部 receipt refs |
| `BUNDLE_VERIFIED` | expected candidate head=DISCOVERED；`bundleBindingRef`+exact `signatureRefs`；result=BUNDLE_VERIFIED | CEB/CAB、全部 approval/effect/completion refs |
| `APPROVAL_REQUIRED` | expected candidate head=BUNDLE_VERIFIED；exact `catalogEvidenceBindingRef`+`catalogAdoptionBindingRef`；result=APPROVAL_REQUIRED；K3 CAB 已绑定 Completion | approval/effect direct refs |
| `INSTALLED_DISABLED` | expected candidate head=APPROVAL_REQUIRED、expected record=null、observed slot；exact CEB/CAB+AdoptionApproval；result record=INSTALLED_DISABLED且 `recordRevision=1`；slot unchanged并复制 exact slotRevision | promotion/stage/git/enable direct refs |
| `ENABLED` | exact EnableApproval所签 `enableMode`、四值`versionTransitionMode`、`targetFullCanonicalVersion`/precedence/Binding、old+new authorityGeneration、expected/proposed history+watermark、allocation；mode必须由history/index matrix唯一派生；expected slot与exact CEB/CAB/receipts；changed record revision checked+1、slot checked+1；target record=ENABLED + slot points new CAB，prior active存在时原子置DISABLED；normal推进watermark，全部successful enable写per-target authority generation history并更新activation history；event payload/envelope/journal/heads/history/watermark/index/allocation consume同事务 | promotion/stage/git/completion direct refs |
| `DISABLED` | expected active record+slot、exact CEB/CAB+prior EnableApproval、bounded reason；result record=DISABLED + empty slot | 新 enable/promotion/effect refs |
| `QUARANTINED`, `REMOVED`, `REVOKED` | expected record/slot（如 active）、exact CEB/CAB、bounded reason + `sanitizedReasonEvidence: {evidenceKind:"sanitized-nonsecret",size,contentDigest:RawContentDigestV1} | null`；result record state且 active slot原子清空 | 新 approval/effect refs |

同一 payload 不得同时声明两个 transition，不能携带另一个分支的 optional receipt。`originClass/sourceTrustDomain/targetInstallationDomain` 均从已验证 binding 投影，event 不得提供可覆盖副本。

- `CapabilityPromotionFenceAllocatorV1={capabilityId,highWatermark:CapabilityReservationFenceV1,version:1}` 是与 capabilityRevision allocator 独立的 per-capability record。Reservation create CAS必须锁 allocator，分配 `capabilityReservationFence=checked(current.highWatermark+1)` 并原子推进 high-watermark；overflow/stale expected拒绝，release/supersede/rollback从不降低。Capability revision 2 可能比 revision 3 晚 reserve，所以 revision绝不代替 fence顺序。
- `CapabilityStageReservationV1` 是 PromotionCoordinationStore 的 exact record `{capabilityId,capabilityReservationFence:CapabilityReservationFenceV1,capabilityRevision,capabilityRevisionAllocationId,capabilityRevisionAllocationCanonicalDigest,catalogEvidenceBindingCanonicalDigest,catalogEvidenceBindingRef,catalogStageEffectId,catalogStageIdempotencyKey,expiresAtMs,gitPromotionEffectId,gitPromotionIdempotencyKey,planCanonicalDigest,promotionApprovalConsumptionCanonicalDigest,promotionApprovalReceiptCanonicalDigest,promotionApprovalReceiptRef,reservationId,runId,state:"STAGE_PENDING"|"AMBIGUOUS_BLOCKED"|"RELEASED_COMPLETED"|"RELEASED_RECONCILED"|"SUPERSEDED_EXPIRED",version:1}`。Typed digest literal roles由field固定；CEB/approval refs与two effect ids/keys必须从same plan exact bytes复制。Create走§19a.8.2 anchored protocol：primary PREPARED transaction锁pointer、fence allocator、exact APPROVED run/approval/CandidateHead/allocation/epochs/deadline与无同revision history，预分配但不发布fence/result recipe；AnchorStore ANCHORED后唯一FINALIZED transaction推进allocator、写consumption/reservation/pointer并发布PROMOTING head，CANCELLED则全部预留mutation=0。Gap内PREPARED锁阻止其他reservation/cancel。Idempotent reread只在所有字段byte-equal时返回；同plan不同CEB/approval/effect冲突。Reservation不再计算revision next；`expiresAtMs` exact等于effective deadline。`STAGE_PENDING`不是Catalog lifecycle。
- `STAGED_DISABLED` 不是write/event；唯一V1定义是matching immutable `RELEASED_COMPLETED` history + exact anchored Completion payload/ref/envelope在同一finalized snapshot的纯投影。Pending reservation、AMBIGUOUS_BLOCKED、RELEASED_RECONCILED或SUPERSEDED_EXPIRED都不得投影。AnchorStore ANCHORED是logical commit；primary PREPARED锁使gap内reader先resolve outcome，随后唯一FINALIZED transaction发布receipt并把reservation→RELEASED_COMPLETED、run→COMPLETED、clear pointer。Independent AnchorStore与primary store不是一个物理transaction。History不删除，later attempt使用strictly-greater revision/fence。
- 普通 expiry supersede只从non-AMBIGUOUS `STAGE_PENDING`开始。Primary PREPARED锁reservation/pointer/exact PROMOTING head/all effect ledgers/receipts/markers，生成linearizable absence proof并使用`expiry-failure-window`；AnchorStore仅在`trustedNow>expiresAtMs`且不晚于policy cleanup upper时ANCHORED PROMOTING→FAILED/recovery_failed。FINALIZED幂等写typed evidence、reservation→SUPERSEDED_EXPIRED、clear pointer；Completion与expiry只能一个PREPARED/ANCHORED winner。Cross-store not-found、未锁key、提前expiry或post-read cleanup不是absence proof。Unresolved AMBIGUOUS只走signed reconciliation，永不TTL supersede。
- `INSTALLED_DISABLED` event 必须引用 exact CAB + AdoptionApprovalReceipt。`ENABLED` event 必须另外引用 exact EnableApprovalReceipt。
- `CapabilityVersionWatermarkV1` 是 per `(capabilityId,targetInstallationDomain)` CAS head `{capabilityId,eventDigest:null|JournalDigestV1,highestNormalEnabledPrecedence:null|CanonicalSemVerPrecedenceV1,targetInstallationDomain,watermarkRevision,version:1}`；virgin为null/revision0/eventDigest null。只有successful normal-upgrade ENABLED验证human-signed expected/proposed、strictly greater并checked推进；discover/adopt/install/failed candidate、reenable/rollback/authority-refresh不改watermark。Build metadata排除precedence；rollback后的next normal仍比较历史high watermark。
- `AcceptedCapabilityContentIndexV1` 是**global** immutable key `(capabilityId,targetFullCanonicalVersion)` 的record `{bundleBindingCanonicalDigest,capabilityId,firstEnabledEventDigest,targetFullCanonicalVersion,version:1}`。任何target domain首次successful ENABLED时create-or-compare；same capability/full version不同Binding跨domain也永久冲突，CEB/CAB不在global content identity中。
- `CapabilityAuthorityGenerationV1` 是 per `(capabilityId,targetInstallationDomain,bundleBindingCanonicalDigest)` monotonic append-only record `{authorityExpiresAtMs,authorityGeneration,capabilityId,catalogAdoptionBindingCanonicalDigest,catalogEvidenceBindingCanonicalDigest,createdByAdoptionEventDigest,previousAuthorityGeneration:null|safeInteger,targetFullCanonicalVersion,targetInstallationDomain,version:1}`；同Binding/version每次fresh endorsement→CEB→CAB必须generation checked+1且link predecessor。`AcceptedCapabilityAuthorityIndexV1`只在successful ENABLED transaction追加 exact record `{authorityGeneration,bundleBindingCanonicalDigest,capabilityId,catalogAdoptionBindingCanonicalDigest,catalogEvidenceBindingCanonicalDigest,enabledCapabilityRevision,enabledEventDigest,targetFullCanonicalVersion,targetInstallationDomain,version:1}`，key恰为`(capabilityId,targetInstallationDomain,bundleBindingCanonicalDigest,authorityGeneration)`；failed-before-enable不accepted。Authority generation可refresh，global content mapping不可替换。
- Reenable/rollback/authority-refresh都使用fresh EnableApproval和current history subject。Restore allocation只选AcceptedCapabilityAuthorityIndex中曾successful ENABLED且仍current-live的exact generation；expired/revoked generation必须先fresh verification/adoption generation。Transaction原子disable prior active、enable target、切slot、更新history和per-target accepted authority index；normal还推进watermark，其他mode保持。Never-active stale INSTALLED_DISABLED不在restore分支。Concurrent enable/content-index create/history swap只有一个CAS winner。
- `sanitizedReasonEvidence` 只有 K0 content-classification ledger给出 signed NONSECRET verdict后才能写 journal；bytes 位于 bounded evidence store并按 media/size/digest重读，secret/unknown没有 digest字段而只能记录 closed reason code。其中 `evidenceKind` 是 closed single-literal type `SanitizedEvidenceKindV1`，唯一值为 `sanitized-nonsecret`；它与 `ClosedMediaRoleV1` 名义不相交，永远不能用作 `ArtifactRefV1.mediaRole`，也不进入 media/schema pair 表。
- `catalog-journal-checkpoint.v1` exact payload是`{anchorVersion,catalogId,checkpointSequence,currentJournalDigest:JournalDigestV1,journalStoreGeneration,journalStoreId,policyEpoch,revocationEpoch,trustEpoch,version:1}`，以purpose=`catalog-journal-anchor`的InlineAuthorityEnvelope签名并由独立protected monotonic store锚定。`CatalogCheckpointHeadV1`是read-only source selector `{anchorVersion,catalogId,checkpointCanonicalDigest:CanonicalPayloadDigestV1(role="catalog-journal-checkpoint.v1"),checkpointSequence,currentJournalDigest:JournalDigestV1,journalStoreGeneration,journalStoreId,version:1}`，只能从该store authenticated head/inclusion proof派生。Genesis sequence0必须生成checkpoint；之后若`newSequence-currentCheckpoint.checkpointSequence>32`则在同一Catalog append transaction生成/签新checkpoint，否则复用current authenticated checkpoint。Checkpoint digest指其sequence exact event，requested head与suffix末event必须同catalog/store/generation且0..32 predecessor可达；rollback/fork/wrong head或caller selector拒绝。
- Journal predecessor 不使用 ArtifactRef。Global `sequence=0` 时 predecessor为 null，其余必须指向 sequence恰少 1 的 event。Global append、receipt challenge consume和所有 listed head compare-and-swap必须在同一 serializable transaction；receipt expected heads必须在 issue和consume时都 field-equal current heads。事务必须先冻结 exact CatalogEvent canonical payload并获得 matching `ArtifactAuthorityEnvelopeV1`，再原子 publish payload bytes + ArtifactRef + detached envelope + new JournalDigest + 全部 materialized heads/watermark/index/receipt outcome；新 head的 `eventDigest`由 transaction在 event finalize/hash后写入而不回填 payload。可见 event 但 envelope/head 缺失、可见 head 但 event/envelope 缺失或后补签名均 invalid/impossible。Fork、rollback、self predecessor、event内 result `eventDigest`或任一 head/event cycle都拒绝。`DISCOVERED` 不可能引用尚未构造的 CEB，`BUNDLE_VERIFIED`也只表示 exact bundle/signature verification；完整 Evidence/Provenance/SBOM/endorsement形成 CEB后才能进入 `APPROVAL_REQUIRED`。

### 19a.10 PermissionTemplate、PermissionSpec 与 SafeDisplay

#### 19a.10.1 Data-only template grammar

`PermissionTemplateV1` 只有 `{version:1,effects:[...]}`；每个template且整个Manifest跨contribution的unique `effects`总数均为0..16项，按effectId排序且不重复。每项 exact shape是 `{version:1,effectId,brokerKind,operation,targetExpr,requestBoundsExpr,budgetExpr,secretOperandPointer:null|<absolute JSON Pointer>,when}`；`when`显式存在。Secret pointer、broker/operation与Manifest `effectsDeclared`必须exact match；不能声明不用或使用未声明pair。只允许下列closed AST：

- `{op:"const",valueType:"null"|"boolean"|"safe-integer"|"control-string",value:<matching native scalar>,version:1}`
- `{op:"select",source:"input"|"item",pointer:<absolute JSON Pointer>,expect:<ValueTypeTagV1>,version:1}`
- `{op:"object",fields:[{name:<ASCII schema key>,value:<expr>}...],version:1}`
- `{op:"array",items:[<expr>...],version:1}`
- `{op:"concat",items:[<control-string expr>...],maxUtf8Bytes:<0..4096>,version:1}`
- `{op:"map",pointer:<array JSON Pointer>,itemExpr:<expr using item>,maxItems:<0..4096>,version:1}`
- Predicate exact variants：`{op:"true"|"false",version:1}`、`{op:"not",arg:<predicate>,version:1}`、`{op:"and"|"or",args:[<predicate>...],version:1}`（2..16 args）、`{op:"eq",left:<scalar expr>,right:<scalar expr>,version:1}`、`{op:"in",needle:<scalar expr>,haystack:[<typed const>...],version:1}`（1..256 sorted unique constants）。不允许 regex、coercion或 locale compare。

JSON Pointer 使用 RFC 6901 `~0/~1`，必须是经 input schema 证明存在且类型固定的 absolute pointer；无 wildcard、parent、default 或 optional fallback。`source="item"` 只在最近一层 `map` 的 `itemExpr` 中合法，且 pointer 以该项为 root；V1 禁止 nested `map`。`map` 只能迭代已验证 bounded array，`maxItems` 不得超过 input schema 上界。

`ValueTypeTagV1` 恰为 `null | boolean | safe-integer | control-string | raw-content-digest | blob-media-type | byte-size | secret-scope | secret-kind | array`。Static checker从 CapabilityValueSchema证明 pointer存在/type一致并传播 taint=`control | nonsecret-content-binding | secret-metadata`。Utf8Text只可 select `encoding/contentDigest/size`，SealedBlob只可 select `blobMediaType/contentDigest/size`，SecretHandle只可 select `scope/secretKind`；bytes/blobId/handleId路径在 registry中不存在。`targetExpr`只接受 control taint（credential target的 scope/kind例外），`requestBoundsExpr`可接受 content-binding metadata，`budgetExpr`只接受 non-negative integer；concat/predicate/when不能消费 content/secret metadata。Fields按 name排序、items保留顺序且所有 duplicate拒绝。

AST depth最多16、node总数最多2,048、所有 string/pointer literal累计64 KiB、单 pointer≤512 ASCII bytes、单 concat result≤4,096 bytes、map展开后 effect-local output nodes≤16,384；整 invocation evaluation的 expression visits + mapped items≤65,536，canonical output≤64 KiB。Static bound无法证明、runtime overflow/type mismatch/missing pointer都返回 deny，不做 partial effect。

Grammar 禁止函数/code/prototype、plugin callback、time/random/network/filesystem/Memory/env 读取、可变状态、动态 module 和未知 operator。K0 在 plugin handler dispatch 前解释 canonical input；每个 `when=true` 产生 exactly one requested effect，false不产生；effectId/pair固定且 template不能动态生成 broker/operation。Missing pointer、type mismatch、overflow、超限、nondeterminism 或 template/effectsDeclared 不一致都 deny。

#### 19a.10.2 PermissionSpecV1

Template 先产生 requested effects，K0 policy meet 再产生 effective effects。`PermissionSpecV1` exact root 是：

```text
{
  "capabilityId": <typed id>,
  "contributionId": <typed id>,
  "effectiveEffects": [NormalizedEffectV1...],
  "effectivePolicyCanonicalDigest": CanonicalPayloadDigestV1(
    role="effective-policy-snapshot.v1"
  ),
  "inputCanonicalDigest": CanonicalPayloadDigestV1(role="invocation-input.v1"),
  "permissionTemplateCanonicalDigest": CanonicalPayloadDigestV1(role="permission-template.v1"),
  "policyEpoch": <non-negative safe integer>,
  "requestedEffects": [NormalizedEffectV1...],
  "totalEffectiveBudget": ResourceBudgetV1,
  "version": 1
}
```

两数组各0..16项，按effectId unsigned ASCII bytes严格排序且unique；requested/effective effectId set必须exact equality，V1无optional/drop。`NormalizedEffectV1` exact fields为`{brokerKind,budget,effectId,operation,policyRuleIds,requestBounds,secretOperandBindingId,target,version:1}`。Requested分支的`policyRuleIds`必须literal `[]`；effective分支为1..64个policy rule id、按bytes sorted unique。Nonsecret effect两分支`secretOperandBindingId=null`；HTTP scoped-credential与credential-sign secret effect两分支都必须non-null且byte-equal，同一effect不得换binding。Matching effect的id/broker/operation/target/secret binding必须相等，只允许registry按brokerKind逐字段对`requestBounds`、allowlist与`budget`取meet；任一policy deny或无法证明逐字段non-widening则整次invocation deny。

`ResourceBudgetV1` exact keys恰为`{brokerCalls,childProcesses,cpuMs,fds,filesystemBytes,httpBytes,pids,rpcBytes,rpcFrames,rssBytes,stderrBytes,stdoutBytes,wallMs,version:1}`，无missing/extra key；每值是non-negative safe integer。每个effective value必须`≤`对应requested值和current policy ceiling；`totalEffectiveBudget`逐key使用checked sum恰等于所有effective effects之和，overflow或任一不等拒绝。Registry必须为七类request bounds冻结field-by-field meet、array set/intersection、nullable与digest equality规则，不能用generic object subset替代。

Secret-using template不能读取handle id。K0生成16-byte `SecretOperandBindingIdV1`，并原子seal closed `secret-operand-binding.v1={bindingId,effectId,expiresAtMs,inputPointer,internalHandleId,invocationId,issuedAtMs,policyEpoch,readBudget:1,revocationEpoch,scope,secretKind,version:1}`（4 KiB）；handle只在protected bytes内。生成时K0必须从 exact verified `invocation-input.v1` 的`inputPointer`解析唯一`SecretHandleRefV1`，逐字段要求`internalHandleId==SecretHandleRef.handleId`、`scope==SecretHandleRef.scope`、`secretKind==SecretHandleRef.secretKind`、`invocationId/effectId/inputPointer`等于PermissionSpec和current invocation，且`expiresAtMs`不晚于input handle、decision、grant与authority ceiling的最早expiry。Caller、mapping和plugin均不能提供或覆盖internalHandleId。

Mapping entry携带`bindingCanonicalDigest:CanonicalPayloadDigestV1(role="secret-operand-binding.v1")`。Operational layer原子CAS readBudget1→0并重新读取exact input+binding bytes，重验digest/role/invocation/effect/pointer/scope/kind/handleId/expiry/epochs/revocation后才解析handle；pure verifier只返回无handle的`VerifiedSecretOperandBindingClaimV1={bindingCanonicalDigest,bindingId,effectId,expiresAtMs,inputPointer,invocationId,policyEpoch,revocationEpoch,scope,secretKind,version:1}`，明确没有`internalHandleId`。最多16 records/64 KiB；cross-swap/stale/revoked/missing/input-handle substitution或同binding重复consume全部拒绝。

`effective-policy-snapshot.v1` 是 protected canonical control bytes，最多32 KiB，固定 policy epoch、sorted exact rule records、target/request/resource ceilings、auto-confirm classes和 source policy provenance；无 executable callback/open extension。PermissionSpec只携带其 role-typed digest，InvocationGrant另携带 exact `effectivePolicyRef: CanonicalObjectRefV1`。Deriver、decision service和 Rust grant verifier都必须从 protected store重读同一 bytes、重算 digest/meet；`policyRuleIds`只作可读审计，绝不替代 policy bytes authority。

`BrokerTargetV1` 是下列 exact tagged union；所有 variant都有 `version:1`，operation field必须与 outer effect相同：

```text
workspace-fs = {kind,operation,workspaceScopeId,path,secondaryPath:null|path,version}
http         = {kind,operation:"request",scheme:"https",dnsName,port,method,
                pathAndQuery,version}
process      = {kind,operation:"spawn-and-wait",executableBinding:ExecutableBindingV1,
                version}
memory       = {kind,operation:"read"|"write"|"delete",scopeId,recordId,version}
ui           = {kind,operation:"request-confirmation",challengeKind,subjectId,version}
credential   = {kind:"credential-sign",operation:"sign-request",secretKind,scope,version}
sealed-blob  = {kind,operation:"read-input"|"create-output",blobMediaType,version}
```

Workspace path使用 portable relative ASCII grammar，无 absolute/root/home；`secondaryPath`只有 rename非 null。HTTP dns是1..253 lowercase ASCII bytes、每 label 1..63且匹配 `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`，无 trailing dot/IP literal/IDNA runtime转换；port 1..65535，method恰为 `DELETE|GET|HEAD|PATCH|POST|PUT`。`pathAndQuery` 是1..4096 ASCII bytes、必须以 `/` 开始，只允许 RFC3986 unreserved/sub-delims、`/ : @`、至多一个 `?` query separator和 uppercase `%HH`；禁止 fragment/userinfo/backslash/control、empty/`.`/`..` path segment、`//`、以及对 unreserved、`.`、`/`、`\`、`?`、`#` 的 percent encoding。Template→PermissionSpec→BrokerTarget→actual request必须 byte-equal该字段，不能只批准 host。Process target必须逐字段复制 exact BuildInputSet `ExecutableBindingV1`，不能只选 logical id/toolchain；Rust从 verified BuildInputSet/runtime closure重建 binding，以 no-follow component walk打开 closure-relative path，拒绝 symlink/reparse/PATH/host fallback，并在 launch前后检查 regular-file identity、target、toolchain、digest、size和 executable mode未变。它只执行该 opened file identity（或平台等价的 identity-pinned handle），无法证明无 TOCTOU时 deny。UI target的 `challengeKind+subjectId` 与 verified activation/invocation/grant/effect lineage共同构成完整 subject。Memory/UI/secret scope/id均是不同 nominal ASCII types。

`BrokerRequestBoundsV1` 按同一 `kind` 的 exact variants为：

```text
workspace-fs = {kind,contentDigest:RawContentDigestV1|null,maxBytes,
                recursive:false,size:null|safeInteger,version}
http         = {kind,headers:[{name,value,version:1}...],
                bodyContentDigest:RawContentDigestV1|null,bodySize,
                credentialMode:"omit"|"scoped-handle",
                credentialOperandBindingId:SecretOperandBindingIdV1|null,maxRedirects:0,
                maxResponseBytes,version}
process      = {kind,argv:[control-string...],cwdScopeId,
                env:[{name,value}...],stdinContentDigest:RawContentDigestV1|null,
                stdinSize,maxOutputBytes,timeoutMs,version}
memory       = {kind,expectedVersion:null|safeInteger,maxRecordBytes,version}
ui           = {kind,challengeTtlMs,version}
credential-sign = {kind,algorithm:"ed25519"|"hmac-sha256",
                   maxPayloadBytes,payloadContentDigest:RawContentDigestV1,
                   secretOperandBindingId:SecretOperandBindingIdV1,version}
sealed-blob  = {kind,contentDigest:RawContentDigestV1|null,maxBytes,size:null|safeInteger,
                version}
```

Header records最多64、按 name bytes排序且 name不重复；argv最多128项/每项≤4 KiB/总计≤32 KiB，env最多64项按 name排序且只允许 manifest/policy closed names；stdin/body/content digest只用于 nonsecret exact binding。Actual `BrokerRequestV1` 不是 bounds object 的开放“具体化”，而是 registry中下列 closed tagged union；每个 variant都有 `version:1`、`operation`且必须与 BrokerTarget outer fields byte-equal：

```text
NonsecretContentSourceV1 =
  {kind:"utf8-text",value:Utf8TextV1,version:1} |
  {kind:"sealed-blob",value:SealedBlobRefV1,version:1}

workspace-fs = {kind,operation,contentSource:NonsecretContentSourceV1|null,
                recursive:false,size:null|safeInteger,version}
http         = {kind,operation:"request",bodySource:NonsecretContentSourceV1|null,
                credentialHandleRef:SecretHandleRefV1|null,
                credentialOperandBindingId:SecretOperandBindingIdV1|null,
                headers:[{name,value,version:1}...],maxResponseBytes,version}
process      = {kind,operation:"spawn-and-wait",argv:[control-string...],cwdScopeId,
                env:[{name,value,version:1}...],stdinSource:NonsecretContentSourceV1|null,
                maxOutputBytes,timeoutMs,version}
memory       = {kind,operation:"read"|"write"|"delete",expectedVersion:null|safeInteger,
                recordValue:NonsecretContentSourceV1|null,version}
ui           = {kind,operation:"request-confirmation",challengeKind,subjectId,version}
credential-sign = {kind,operation:"sign-request",algorithm:"ed25519"|"hmac-sha256",
                   payloadSource:NonsecretContentSourceV1,
                   secretHandleRef:SecretHandleRefV1,
                   secretOperandBindingId:SecretOperandBindingIdV1,version}
sealed-blob  = {kind,operation:"read-input",blobRef:SealedBlobRefV1,version} |
               {kind,operation:"create-output",blobMediaType,
                maxBytes,outputReservationId,version}
```

Variant-dependent nullability是 closed：workspace write-file要求 contentSource+size且其他 fs ops要求 null；process size/digest从 stdin source重算；memory write要求 value、read/delete要求 null；HTTP body/credential必须分别满足 bounds mode，所有 source size/digest重算并不超过 effective ceiling。Header name是1..64 lowercase ASCII，value是≤8 KiB control-string且禁止 CR/LF/C0/C1；K0-owned forbidden set恰为 `authorization,connection,content-length,cookie,host,proxy-authorization,proxy-connection,te,trailer,transfer-encoding,upgrade`，plugin/template/actual headers均不得出现。PermissionTemplate必须从允许的 control input确定性派生每个 non-auth `{name,value}`，PermissionSpec冻结 exact sorted records，actual必须 byte-equal，不能只批准 name再让 handler选择 value。Scoped credential只允许 `http.credentialHandleRef` 与 `credential-sign.secretHandleRef` 两个 slots；K0/Rust按 exact scope/secret kind验证，并只在 HTTP发送边界内部注入 policy-owned auth header，credential bytes/header不能回传 plugin、进入 response/log或被 redirect继承。V1 `maxRedirects`必须 literal 0；每个 HTTP token只授权 exact scheme/dns/port/method/pathAndQuery和一次 network hop。3xx只能返回 bounded sanitized Location给 K0并结束 effect；要 follow必须新建 invocation、重新派生 PermissionSpec/SafeDisplay/DecisionProof/InvocationGrant和 exact Broker token，不能在旧 grant内由 runtime policy扩权。UI bounds/actual **MUST NOT** 含 SafeDisplay/mapping digest/ref；actual `challengeKind/subjectId` 必须 byte-equal target。Rust-issued UI token验证和消费后，K0才从 verified lineage + target确定性生成 UI display；result只回答该 exact effect/token subject，不是 HumanDecision/DecisionProof/receipt，不能授权另一个 effect、grant或 lifecycle transition。Blob id只可出现在上述 sealed-blob/content source slots。Template/PermissionSpec永不含/派生 handle id/blob id。Registry必须对七类 bounds/actual variant生成 TS/Rust types，并为每个 field/nullability/executable binding/UI lineage/exact header value/forbidden header/credential slot/path/query/redirect edge提供 golden/reject。

Meet algebra固定为 `effective = meet-v1(requested, Manifest resource envelope, current protected policy snapshot, activation remaining budget, principal limits)`：requested/effective effectId sets exact equality；每个 broker/operation/target/secret operand必须 exact match或整次 invocation deny；numeric ceiling取 minimum，allow-list取 set intersection，boolean ceiling取 logical AND，exact content binding必须相等，不能通过“收窄”换 path/host/argv/handle。Empty required intersection、policy deny或 unrepresentable meet都 deny而非静默删 effect；policy不得新增 effect。Deriver必须持有/recompute Manifest template、input和 current policy bytes，SafeDisplay与 human/auto decision只绑定最终 effective spec。PermissionSpec是 invocation upper bound，不是 effect token，且不得含 wildcard、host path、socket/fd/process handle、raw credential、SafeDisplay或 mapping back-reference。

#### 19a.10.3 Injective SafeDisplayV1

`SafeDisplayV1` exact root是 `{decisionBytesBase64Url,decisionEntries,decisionNonce:DecisionNonceV1,subject:SafeDisplaySubjectV1,version:1}`。`SafeDisplaySubjectV1` 是下列 closed tagged union；common fields恰为 `decisionKind`、`principalId`、`policyEpoch`、`trustEpoch`、`revocationEpoch`、`version:1`，每个 branch只允许列出的额外字段：

```text
promotion = common(decisionKind="promotion") + {
  capabilityRevision, capabilityRevisionAllocationId,
  capabilityRevisionAllocationCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  catalogEvidenceBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),
  expectedSelfDevRunHeadSubject:SelfDevRunHeadSubjectV1(state="AWAITING_HUMAN"),
  selfDevApprovalContextCanonicalDigest:
    CanonicalPayloadDigestV1(role="selfdev-approval-context.v1"),
  selfDevPromotionPlanCanonicalDigest:
    CanonicalPayloadDigestV1(role="selfdev-promotion-plan.v1"),
  selfDevRunJournalAnchorCanonicalDigest:
    CanonicalPayloadDigestV1(role="selfdev-run-journal-anchor-payload.v1")
}
adoption = common(decisionKind="adoption") + {
  capabilityRevision, capabilityRevisionAllocationId,
  capabilityRevisionAllocationCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  catalogAdoptionBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-adoption-binding.v1"),
  expectedCandidateHeadSubject, expectedInstallationRecordHeadSubject:null,
  observedActivationSlotHeadSubject, targetInstallationDomain
}
enable = common(decisionKind="enable") + {
  capabilityRevision, capabilityRevisionAllocationId,
  capabilityRevisionAllocationCanonicalDigest:
    CanonicalPayloadDigestV1(role="capability-revision-allocation-record.v1"),
  catalogAdoptionBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-adoption-binding.v1"),
  catalogPermissionProjectionCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-permission-projection.v1"),
  enableMode:"initial"|"restore", expectedActivationHistorySubject,
  expectedActivationSlotHeadSubject, expectedInstallationRecordHeadSubject,
  expectedVersionWatermarkSubject, previousAuthorityGeneration,
  proposedActivationHistorySubject,
  proposedVersionWatermarkSubject, targetBundleBindingCanonicalDigest,
  targetAuthorityGeneration, targetFullCanonicalVersion, targetSemVerPrecedence,
  versionTransitionMode:"normal-upgrade"|"reenable"|"rollback"|"authority-refresh"
}
invocation = common(decisionKind="invocation") + {
  activationId,
  activationPayloadCanonicalDigest:
    CanonicalPayloadDigestV1(role="activation-token-payload.v1"),
  activationSlotHeadSubject,
  catalogEvidenceBindingCanonicalDigest:
    CanonicalPayloadDigestV1(role="catalog-evidence-binding.v1"),
  effectivePolicyCanonicalDigest:
    CanonicalPayloadDigestV1(role="effective-policy-snapshot.v1"),
  inputCanonicalDigest:CanonicalPayloadDigestV1(role="invocation-input.v1"),
  installationRecordHeadSubject,
  invocationId,
  permissionSpecCanonicalDigest:
    CanonicalPayloadDigestV1(role="permission-spec.v1"),
  principalCanonicalDigest:CanonicalPayloadDigestV1(role="principal-descriptor.v1"),
  reconciledLineageDependencyCanonicalDigest:
    null|CanonicalPayloadDigestV1(role="reconciled-lineage-dependency.v1"),
  safeDisplayDecisionMappingCanonicalDigest:
    null|CanonicalPayloadDigestV1(role="safe-display-decision-mapping.v1")
}
```

Unknown/cross-branch field和 wrong discriminator均拒绝。SafeDisplay/subject 不含任何 ArtifactRef、opaque handle或 SafeDisplay自身 digest；生成/验证 API 必须从 containing receipt、Activation/Grant的顶层 CEB/CAB refs及 protected PermissionSpec container取得 exact canonical bytes并逐个重算，不能接受 caller-provided、wrong-role或无法解析的裸 digest。Promotion subject的context/head/anchor三者必须和Receipt唯一 sibling context/anchor及 current AWAITING_HUMAN head逐字段相等；任一run/version/generation/anchor/context drift都要求fresh challenge。Subject bytes在 fingerprint、mapping或 SafeDisplay typed digest产生前就完全确定，因此不存在 subject↔SafeDisplay self-digest cycle。

`SafeDisplayProjectionV1` 不是 caller 可传的 map，而是 registry生成器冻结的四分支 typed tree derivation `safe-display-projection-v1`。输入与必须完整投影如下；每个 field path、排序、literal null和absent规则都在 registry中closed，未列 branch field必须 absent：

| branch | exact verified inputs | exhaustive decision-relevant projection |
|---|---|---|
| promotion | exact CEB→endorsement `selfDevRunContext`/verification/acceptance/limitations/participants、CEB plan/permission/sandbox projection、receipt唯一 approval context+AWAITING anchor、current `SelfDevRunHeadSubject`、CandidateHead、allocation | goal/criteria原UTF-8 bytes、budget limits+usage、generation/repair facts、base/candidate/revision/allocation、current run state/version/anchor、acceptance/verification/limitations/isolation identities、full plan两种 effect target/write intent/deadlines、permission/resource/sandbox maxima与epochs |
| adoption | exact CAB→CEB/Binding/Manifest/permission/resource/sandbox、Candidate/Record/Slot subjects与 target domain | origin/source/target trust domains、full version/binding、candidate/revision/allocation、current active-or-empty slot、record-create write intent、permission/effect/resource/sandbox maxima与known limitations |
| enable | exact CAB/CEB, expected record/slot/history, allocation, host profile/probe, contribution set, global content/per-target authority-generation index与SemVer watermark heads | enable/version modes、target full canonical version+precedence+Binding、old/new authority generation、expected/proposed history+watermark、record/slot swap与rollback/refresh intent、all contributions、maximum permissions/effects/resources、sandbox/profile/probe/authority expiry/epochs |
| invocation | exact activation/record/slot lineage、principal/input/template/effective PermissionSpec/policy、requested budget、secret-use mapping metadata | effective target/request for every sorted effectId、all bounds/budget/write intent、principal and lineage heads/epochs/expiry plus each secret-use `{effectId,inputPointer,secretOperandBindingId,decisionScopedAlias,scope,secretKind}` |

Projection builder必须先完成上述 closure/current-state验证，再纯派生closed tree；NonsecretUtf8Bytes保持原bytes，secret leaf只含decision-scoped summary。Projection最多4,096 nodes、rendered bytes最多256 KiB、SafeDisplay root最多1 MiB、secret mapping最多16 entries/32 KiB；Manifest全局effects≤16保证secret上界可达。这些bounds在admission静态预检并runtime复核；超过只能typed deny，不能截断/摘要/分页批准。Entries必须exhaustive preorder且renderer byte-equal。

`decisionEntries` 是 closed array，按 canonical tree preorder：object children按 field-name unsigned UTF-8 bytes，array children按 numeric index。它是 exact tagged union：container=`{pathEscaped,pathEscapedByteLength,pathUtf8ByteLength,nodeKind:"object"|"array",childCount,version:1}`；nonsecret scalar=`{pathEscaped,pathEscapedByteLength,pathUtf8ByteLength,nodeKind:"null"|"boolean"|"integer"|"string"|"utf8-bytes",valueEscaped,valueEscapedByteLength,valueUtf8ByteLength,version:1}`；secret=`{pathEscaped,pathEscapedByteLength,pathUtf8ByteLength,nodeKind:"secret",decisionScopedAlias,secretKind,scope,nonsecretFingerprint,version:1}`。`utf8-bytes`只来自已验证NonsecretUtf8Bytes decoded bytes；其他string来自canonical control strings。Path先构造absolute RFC6901（根empty；segment `~→~0,/→~1`），再执行以下display escape；每个container也有entry，所以missing/null/empty/index不折叠。

`displayEscapeV1` 逐Unicode scalar：ASCII `0x20..0x7e`原样，唯独backslash输出两bytes `\\`、double quote输出 `\"`；其余输出ASCII `\u{XXXXXX}`，`XXXXXX`恰为六位uppercase hex（含leading zero）。Invalid UTF-8/lone surrogate拒绝；无short escape、locale、terminal styling或normalization。Scalar raw bytes映射恰为：null=`ASCII("null")`；boolean=`ASCII("true")|ASCII("false")`；integer=Canonical JSON V1 safe integer decimal（负号按值、0除外无leading zero）；string=其原UTF-8 bytes；utf8-bytes=`NonsecretUtf8BytesV1` strict base64url decode后的原bytes。`childCount`只计该container的**immediate** object fields或array elements，不计descendants。

Renderer输出literal ASCII+LF：container enter=`B|<kind>|<rawPathLen>|<escapedPathLen>|"<path>"|<childCount>\n`，children后=`E|<kind>|<rawPathLen>|<escapedPathLen>|"<path>"\n`；nonsecret leaf=`V|<kind>|<rawPathLen>|<escapedPathLen>|"<path>"|<rawValueLen>|<escapedValueLen>|"<value>"\n`；secret leaf=`S|secret|<rawPathLen>|<escapedPathLen>|"<path>"|<rawSummaryLen>|<escapedSummaryLen>|"<summary>"\n`。所有decimal length/count无leading zero（0除外）；length分别按raw UTF-8和final escaped ASCII bytes重算。Parser先读decimal escaped length，再恰好消费该数量bytes，绝不扫描quoted bytes中的`|`或其他delimiter，因此literal pipe不产生第二种parse。Secret summary是`{decisionScopedAlias,nonsecretFingerprint,scope,secretKind}` canonical JSON bytes，不含actual handle/raw secret/secret-derived length或digest。Renderer必须从exhaustive entries重建bytes并byte-equal strict-decoded `decisionBytesBase64Url`；UI必须逐byte显示exact rendered UTF-8并同时显示SafeDisplay typed digest，localized label只能附加且不得替代/重排/折叠signed bytes。

令 `safeDisplaySubjectCanonicalBytes` **唯一**等于 `SafeDisplay.subject` exact `SafeDisplaySubjectV1` object 的 Canonical JSON V1 bytes（不含 container/domain prefix），`decisionNonceBytes = strict_base64url_no_padding_decode(SafeDisplay.decisionNonce)` 且必须恰为32 raw bytes。Fingerprint是 `{algorithm:"hmac-sha256-128",keyId,value}`，其中 full HMAC preimage恰为 `ASCII("plugin-kernel-safe-display-secret\0v1\0") || uint64_be(len(safeDisplaySubjectCanonicalBytes)) || safeDisplaySubjectCanonicalBytes || decisionNonceBytes || uint64_be(len(internalHandleIdBytes)) || internalHandleIdBytes`，再截前16 bytes并 base64url/no-padding。Nonce 部分不加长度帧（因 nominal type已固定32 bytes），绝不得拼接43-byte ASCII token；internal handle 仍使用显式 uint64 length frame。不得只选 subject中的某个 digest、把 digest objects拼接、加入 final SafeDisplay digest，或使用非 canonical field order。Key是 display-only epoch key且不可导出；decision nonce + exact subject使同一 secret跨 decision不可关联。Registry/golden 必须锁定完整 offsets/bytes，并用 decoded-vs-ASCII 差异向量及 padded/noncanonical nonce reject防止两语言分叉。

HMAC truncation/随机alias不宣称数学无碰撞。K0 seal最大32 KiB `safe-display-decision-mapping.v1={decisionNonce,entries,safeDisplayCanonicalDigest,subject:SafeDisplaySubjectV1,version:1}`；subject与SafeDisplay byte-equal。Entries 1..16个`{bindingCanonicalDigest:CanonicalPayloadDigestV1(role="secret-operand-binding.v1"),decisionScopedAlias,effectId,inputPointer,nonsecretFingerprint,scope,secretKind,secretOperandBindingId,version:1}`，排序且key/alias/fingerprint unique。Mapping无handle/raw secret；verifier重读protected binding。SafeDisplay不回指mapping；Proof/Grant绑定mapping digest，A/B是protected object refs而非secret bearer ids。

每个 secret-using effect/request另必须有 decision entry展示 `{effectId,inputPointer,secretOperandBindingId,decisionScopedAlias,scope,secretKind}`，binding id只能经 protected mapping解析到 exact alias；Rust从 PermissionSpec + mapping重建该 projection。两个同 kind/scope handles交换 effect binding时 SafeDisplay decision bytes/digest必须变化或生成阶段deny，不能只在 input tree列 aliases而隐去哪个 effect使用哪个。

### 19a.11 Authority envelopes 与 Rust lineage

#### 19a.11.1 AuthorityEnvelopeV1

```text
InlineAuthorityEnvelopeV1 = {
  "algorithm": "ed25519",
  "issuerKeyId": <typed key id>,
  "keyPurpose": <closed purpose matching expected endpoint>,
  "payload": AuthorityCanonicalPayloadV1(role=<expected authority payload role>),
  "signatureBase64Url": <64-byte detached signature>,
  "version": 1
}

ArtifactAuthorityEnvelopeV1 = {
  "algorithm": "ed25519",
  "issuerKeyId": <typed key id>,
  "keyPurpose": <closed purpose matching signed artifact role>,
  "signatureBase64Url": <64-byte detached signature>,
  "signedArtifact": ArtifactRefV1(<receipt | endorsement | catalog-event pair>),
  "signedSchemaRole": <exact ClosedSignedArtifactSchemaRoleV1>,
  "version": 1
}

AuthorityEnvelopeV1 = InlineAuthorityEnvelopeV1 | ArtifactAuthorityEnvelopeV1
```

Endpoint 预先决定 exact union variant、expected role和 key purpose，重算 payload/ref与 signature preimage；envelope 内字段不能扩大权限。`ClosedAuthorityPayloadRoleV1` 的唯一literal enum恰为：`activation-token-payload.v1 | invocation-decision-proof.v1 | invocation-grant-payload.v1 | broker-call-token-payload.v1 | catalog-journal-checkpoint.v1 | selfdev-run-journal-event.v1 | selfdev-run-journal-anchor-payload.v1 | selfdev-run-journal-checkpoint.v1 | approval-consumer-permit.v1 | completion-worker-permit.v1 | ambiguity-reconciliation.v1 | lineage-reconciliation-release.v1`。Inline variant只允许这些十二个role；所有 receipt/endorsement/CatalogEvent ArtifactRef都只用 ≤8 KiB detached `ArtifactAuthorityEnvelopeV1`，避免 nested base64 size矛盾。

Artifact verifier先要求 envelope `signedArtifact` 与 caller lookup ref field-for-field equal，按该 ref exact-size fetch payload，执行 raw/canonical/strict schema并重算 ref，再以 caller-expected `signedSchemaRole` 的**完整 fetched canonical bytes**构造 signature preimage；envelope自报 role、ref/digest hex本身不是签名 message，也不构成 authority。`envelope_B under ref_A`、同 bytes换 receipt role、只签 digest都拒绝。两种 envelope都独立存储且不进入 ArtifactRef DAG，因此没有 payload↔signature cycle。

`ClosedKeyPurposeV1` 的唯一literal enum恰为：`catalog-verification-endorser | catalog-stage-worker | git-promotion-worker | adoption-approver | enable-approver | catalog-writer | activation-issuer | invocation-decision-issuer | invocation-issuer | broker-issuer | catalog-journal-anchor | selfdev-run-journal-event | selfdev-journal-anchor | selfdev-run-journal-checkpoint | promotion-approval-consumer | selfdev-completion-worker | selfdev-transition-finalizer | ambiguity-reconciler | lineage-reconciliation-finalizer`。Bundle publisher `SignatureEnvelopeV1`使用独立publisher trust purpose=`bundle-publisher`且wire无`keyPurpose`；四个`human-*` purpose只签`human-decision.v1`，都不属于`ClosedKeyPurposeV1`。

Role→purpose mapping是下列完整table，不存在implicit同名或“其他role”：

| expected signed role | exact `keyPurpose` |
|---|---|
| `catalog-verification-endorsement.v1` | `catalog-verification-endorser` |
| `promotion-approval-receipt.v1` | `selfdev-transition-finalizer` |
| `catalog-stage-receipt.v1` | `catalog-stage-worker` |
| `git-promotion-receipt.v1` | `git-promotion-worker` |
| `selfdev-completion-receipt.v1` | `selfdev-transition-finalizer` |
| `adoption-approval-receipt.v1` | `adoption-approver` |
| `enable-approval-receipt.v1` | `enable-approver` |
| `catalog-event.v1` | `catalog-writer` |
| `activation-token-payload.v1` | `activation-issuer` |
| `invocation-decision-proof.v1` | `invocation-decision-issuer` |
| `invocation-grant-payload.v1` | `invocation-issuer` |
| `broker-call-token-payload.v1` | `broker-issuer` |
| `catalog-journal-checkpoint.v1` | `catalog-journal-anchor` |
| `selfdev-run-journal-event.v1` | `selfdev-run-journal-event` |
| `selfdev-run-journal-anchor-payload.v1` | `selfdev-journal-anchor` |
| `selfdev-run-journal-checkpoint.v1` | `selfdev-run-journal-checkpoint` |
| `approval-consumer-permit.v1` | `promotion-approval-consumer` |
| `completion-worker-permit.v1` | `selfdev-completion-worker` |
| `ambiguity-reconciliation.v1` | `ambiguity-reconciler` |
| `lineage-reconciliation-release.v1` | `lineage-reconciliation-finalizer` |

Promotion human签名只允许`human-promotion-decision`；PromotionApproval artifact envelope只允许durable K0 `selfdev-transition-finalizer`。同理completion worker只签pre-anchor permit，Completion artifact envelope由独立finalizer签。Cross-purpose/unknown/alias、finalizer冒充human/worker、worker签post-anchor artifact全部拒绝。

#### 19a.11.2 HostBootstrapProfileV1

Profile 是 canonical embedded control payload，且不提供任意 host path/network 字段：

```text
{
  "buildInputSetRef": <binding's exact build input set>,
  "bundleBindingRef": <sealed bundle>,
  "environmentProfileId": <K0 closed profile id>,
  "fileManifestRef": <exact bundle files>,
  "filesystemPolicyBinding": <exact binding for runtimeTarget>,
  "inheritedHandles": [],
  "ipc": {"channelId": <opaque id>, "count": 1},
  "network": {"enabled": false},
  "privateDataScopeId": <opaque logical scope>,
  "resourceBudget": <hard bounded budget>,
  "runtimeClosureCanonicalDigest": CanonicalPayloadDigestV1(
    role="runtime-closure.v1"
  ),
  "runtimeTarget": <closed target triple>,
  "scratchScopeId": <opaque logical scope>,
  "stderrMode": "bounded-diagnostics",
  "stdoutMode": "bounded-diagnostics",
  "version": 1
}
```

`network.enabled` 是 literal `false`，不是可选布尔值。Schema 中没有 `readRoots`、`writeRoots`、`networkAllowlist`、`workspacePath`、`homePath`、`PATH`、proxy env 或任意 mount。Rust 必须从 exact BuildInputSet 的 embedded runtime closure bytes 重算同 target `runtimeClosureCanonicalDigest`，并要求 `filesystemPolicyBinding` 与 BundleBinding/target closed mapping byte-equal，再解析 runtime closure、bundle RO、private data、scratch 和唯一 IPC；profile 不携带 plugin 控制的 concrete host path。`inheritedHandles` V1 必须是空数组。

#### 19a.11.3 ActivationTokenPayloadV1

Activation token 必须绑定：

- `activationId`、`capabilityId`、exact contribution set，以及 `principalRef: CanonicalObjectRefV1(role="principal-descriptor.v1", scopeKind="activation", scopeId=activationId)`；principal bytes 只含 typed principal id、installation domain、session/actor class 与 K0 scope，不含 credential。
- exact CEB、CAB、AdoptionApprovalReceipt、EnableApprovalReceipt；K3 的 CAB 间接绑定 matching CompletionReceipt。
- immutable `originClass/sourceTrustDomain`、`targetInstallationDomain`、`LifecycleState=ENABLED`、exact current `InstallationRecordHeadV1(state="ENABLED")` + `ActivationSlotHeadV1(active CAB/CEB matching token)`、policy/trust/revocation epochs。
- `hostBootstrapProfileRef: CanonicalObjectRefV1(role="host-bootstrap-profile.v1", scopeKind="activation", scopeId=activationId)`、`persistentHostProbeRef: CanonicalObjectRefV1(role="persistent-host-probe.v1", scopeKind="activation", scopeId=activationId)`、exact BundleBinding/FileManifest ArtifactRefs。Probe bytes 固定 platform/backend/runtime-closure/probe-command `ExternalDigestV1`、与 Binding/Profile byte-equal 的 `FilesystemPolicyBindingV1`、逐 feature result、tier、observedAt/expiry；Activation issuer 从 current probe store 重建并拒绝调用端自报结果。
- wall/CPU/RSS/PID/FD/output/RPC/process budget，`issuedAtMs/notBeforeMs/expiresAtMs`、single-use `activationNonce:ActivationNonceV1`。

Activation payload wire schema **MUST NOT** 出现上述三个 role 的 `EmbeddedCanonicalV1`/`bytesBase64Url`；只有对应 `CanonicalObjectRefV1`。Rust 在 spawn 前从 protected store 重读三个 exact canonical objects、重读完整 artifact closure/current stores，按消费CatalogEvent时间历史验证Adoption/Enable receipt、同时检查current key/revocation/CEB authority expiry/profile equality/budgets，并在同一 serializable transaction中检查 state/deadline、消费 typed activation payload canonical digest + `ActivationNonceV1`和三个 sidecar read budget、reserve bootstrap budget、创建 `AuthorityContextRefV1(contextKind="activation")`。任一条件/race失败都不留 reservation/context。Token 过期、epoch/head/current authority/probe 变化、收据 lineage mismatch 或 P0-00 fence 仍关闭时都不得 spawn。

`resourceBudget`/token budgets 使用同一 closed object：`wallMs`、`cpuMs`、`rssBytes`、`pids`、`fds`、`stdoutBytes`、`stderrBytes`、`rpcBytes`、`rpcFrames`、`brokerCalls`、`filesystemBytes`、`httpBytes`、`childProcesses`。每项都是非负 safe integer 且必须小于 K0 platform/policy ceiling；missing/unknown field、总量或逐 effect reservation overflow 均拒绝。

#### 19a.11.4 InvocationDecisionProofV1

TS/UI 传入的 `confirmed=true`、SafeDisplay bytes或 policy label都不是 authority。K0 decision service必须生成 `invocation-decision-proof.v1` exact payload，并以 `keyPurpose="invocation-decision-issuer"` 的 InlineAuthorityEnvelope签名后与 payload一起 seal进 protected store。Common fields固定 activation context/id/payload digest、invocation id、CEB、principal/input/PermissionSpec/SafeDisplay/effective-policy typed canonical digests、`safeDisplayDecisionMappingCanonicalDigest:null|CanonicalPayloadDigestV1(role="safe-display-decision-mapping.v1")`、`reconciledLineageDependencyCanonicalDigest:null|CanonicalPayloadDigestV1(role="reconciled-lineage-dependency.v1")`、`reconciledLineageDependencyRef:null|CanonicalObjectRefV1(role="reconciled-lineage-dependency.v1",scopeKind="invocation",scopeId=invocationId)`、exact InstallationRecord/ActivationSlot heads、policy/trust/revocation epochs、`issuedAtMs/expiresAtMs`与 single-use `decisionNonce:DecisionNonceV1`；human-only challenge fields不在 common。Current provider/resource terminal marker存在时dependency digest/ref都必须non-null、proof必须human branch且从protected dependency/release/reconciliation bytes重算；无marker时两者必须null。

`decisionSource` 是 closed union：

- `human` 分支必须含 `challengeId:ChallengeIdV1`、single-use `challengeNonce:HumanChallengeNonceV1`、`humanParticipant: EmbeddedCanonicalV1(role="human-participant-binding.v1")`、`humanDecision: EmbeddedCanonicalV1(role="human-decision.v1")` 与 `humanSignatureBase64Url`；human decision decoded payload的 discriminator必须 literal `decisionKind="invocation"`，human key purpose必须是 `human-invocation-decision`。Verifier按 §19a.9.2 exact invocation variant重建 decision bytes：所有 typed digest、no-ref head subject、challenge/decision nonce、epochs与 expiry必须和 proof common + human fields逐字段 byte-equal，任何 receipt-only branch field都 forbidden。Challenge consume、proof seal、secret时mapping handle A和marker时dependency handle A read/consume在同一 CAS，proof record保存 verified mapping/dependency bytes与typed digests。
- `auto-policy` 分支必须含 exact protected base-policy rule id、从 current policy canonical bytes重算的 role-typed digest、decision=`no-confirmation-required`和 rule evaluation evidence；`challengeId`、`challengeNonce`、human participant/decision/signature及 secret mapping/SecretHandle effect全部 forbidden。只允许 policy registry明确标为 auto、PermissionSpec effect class/target/budget在该 rule严格上界内时签发，TS/Manifest/plugin不能声明 auto class。

Decision service首先返回 `decisionProofIssueRef: CanonicalObjectRefV1(role="invocation-decision-proof.v1",scopeKind="invocation")`，其 protected record同时保存/验证 InlineAuthorityEnvelope；payload/ref/envelope任一不匹配都拒绝。Invocation issuer必须重读 exact proof bytes/envelope、recompute all subject digests/heads并在 grant issuance transaction中单次消费 issue ref，将 proof digest标为 claimed，然后把**同一 payload+envelope bytes** seal成 fresh、不同 handle的 `invocationDecisionProofRef` 供 Grant携带；marker branch还从proof record保存的verified dependency bytes seal fresh dependency handle B。Issue/grant proof refs以及dependency A/B refs各自role/digest/size/scope byte-equal但handle不同，不能跨 envelope复用。Proof不能跨 invocation、input/spec/display/mapping/dependency、policy epoch或 principal重放。

#### 19a.11.5 InvocationGrantPayloadV1

Invocation grant 必须绑定 `activationContextRef: AuthorityContextRefV1(contextKind="activation")`、`activationPayloadCanonicalDigest: CanonicalPayloadDigestV1(role="activation-token-payload.v1")`/activation id、CEB/CAB/contribution，以及从 verified activation ledger byte-equal 延续的 principal identity。它还必须绑定：

- Required seven invocation refs恰为`principalRef(role="principal-descriptor.v1")`、`inputRef(role="invocation-input.v1")`、`permissionTemplateRef(role="permission-template.v1")`、`permissionSpecRef(role="permission-spec.v1")`、`safeDisplayRef(role="safe-display.v1")`、`effectivePolicyRef(role="effective-policy-snapshot.v1")`、`invocationDecisionProofRef(role="invocation-decision-proof.v1")`，全部scopeKind=`invocation`/scopeId=current invocation。Secret时另required唯一mapping ref及1..16 `secretOperandBindingRefs(role="secret-operand-binding.v1")`，按bindingId排序且与PermissionSpec/mapping exact set相等；terminal marker存在时另required唯一fresh `reconciledLineageDependencyRef(role="reconciled-lineage-dependency.v1")`，否则该ref及digest都必须null/absent。Proof/Grant相应typed digests、dependency A/B bytes与current marker/head重算相等；fresh proof/dependency handles分别不等于issue/proof-side handles。
- `inputRef` 指向的 bytes 内含从 exact Manifest contribution 重算的 input-schema typed digest + canonical input value；`permissionTemplateRef` bytes 必须与 Manifest embedded template byte-equal，PermissionSpec/SafeDisplay 则从同一 input/template/decision重建。所有 role/size/typed digest 都从 protected-store bytes 与 Manifest 重算。
- catalog/policy/trust/revocation epochs、deadline、upper-bound total/effect budgets、`invocationId`、`invocationGrantNonce:InvocationGrantNonceV1`/issued/expiry。

Invocation payload wire schema **MUST NOT** 内嵌 input/template/spec/display/policy/principal/decision/binding/dependency bytes；只允许上述 refs。Rust 必须逐项reload exact principal、input、permission-template、permission-spec、SafeDisplay、effective-policy、decision-proof七个required ref bytes；secret分支再reload唯一mapping与1..16 binding bytes，terminal-marker分支再reload唯一dependency bytes，并通过`VerificationSourcesV1`继续取得dependency所绑定的lineage release、每个reconciliation payload+InlineAuthorityEnvelope与current terminal marker。全部role/size/digest/scope/readBudget/expiry/revocation计入2 MiB aggregate。Verifier逐字段证明input `SecretHandleRef`↔binding↔mapping↔PermissionSpec、dependency↔proof/grant/current marker相等，并验证 fresh decision-proof ref authority envelope及已claimed issue record equality。随后同一serializable transaction按sorted ref key原子消费grant nonce、fresh proof、其余sidecar及每个binding/dependency `readBudget:1→0`，reserve budget、将 grant `ISSUED→DISPATCHED`并创建Invocation context；任一CAS loser/缺失/extra ref mutation=0。Issue ref已在grant issuance消费，绝不能在dispatch再消费。Verified bytes可在该 invocation的K0 context中复用，之后才可发bounded handler frame；Grant不执行effect或提供reusable fd/socket/process handle。

#### 19a.11.6 BrokerCallTokenPayloadV1

每个 concrete effect 都要求新 token，并绑定：

- exact `invocationContextRef: AuthorityContextRefV1(contextKind="invocation")`、`invocationGrantCanonicalDigest: CanonicalPayloadDigestV1(role="invocation-grant-payload.v1")`、activation/invocation/effect ids、与 verified invocation ledger byte-equal 的 principal typed digest、current epochs/revocation。
- exact `brokerKind`、`operation`、`targetRef: CanonicalObjectRefV1(role="broker-target.v1", scopeKind="effect", scopeId=effectId)`、`requestRef: CanonicalObjectRefV1(role="broker-request.v1", scopeKind="effect", scopeId=effectId)`。
- `idempotencyKey:IdempotencyKeyV1`、effect ordinal，以及 resource/amount budget reservation；target/request typed canonical digests 和 sizes 只来自两个 refs，并在 reload 后重算，不另接受 caller-provided 泛化摘要。
- single-use `brokerCallNonce:BrokerCallNonceV1`、`issuedAtMs/expiresAtMs`；expiry 不得超过 grant/activation deadline。

Broker payload wire schema **MUST NOT** 内嵌 target/request bytes。Rust issuer 必须重新 canonicalize plugin 候选 request，写入/seal 两个 protected objects，证明它相对 PermissionSpec/grant是 **equal-or-narrower、non-widening subset**，先构造待签 token，再在同一 invocation-context transaction中重查 state/deadline/idempotency/ordinal、原子 reserve exact budget并记录 token digest；只有 commit 后才可向 plugin发布 signature，签名/commit失败必须撤销 objects/reservation。Broker 在 effect 前 reload refs，并在同一 ledger transaction中消费 token nonce + 两个 read budget、确认 reservation后才执行；Rust-owned workspace-fs/HTTP/process broker直接执行 OS effect并保存可对账结果。Memory/UI 等 TS logical broker也必须在 protected ledger CAS消费 Rust-issued token；CAS loser/replay/mismatch不执行。Sibling path/host/port/op、request mutation、换 ref/grant/principal、budget widening或 nonce replay都拒绝。

每个 effect idempotency record 使用 closed outcome state `RESERVED → CONSUMED → SUCCEEDED | FAILED_DETERMINISTIC | AMBIGUOUS`；RESERVED 在 token 过期仍未消费时由 protected ledger 置 `FAILED_DETERMINISTIC`（failureCode=`EXPIRED`），不得无限期滞留而阻塞 lineage release；且`AMBIGUOUS → RECONCILED_NOT_OCCURRED | RECONCILED_OCCURRED_EXACT`是唯一post-terminal audit edge；两种reconciled state仍永久禁止旧lineage执行。Reservation transaction写 exact token/target/request typed digests和 budget；effect前 CAS到 CONSUMED并写 attempt id，OS/logical outcome必须 durable后才能 SUCCEEDED/FAILED。Crash recovery policy按 broker operation在 registry标记：transactional/queryable workspace-fs/memory/UI和 content-addressed sealed-blob可用 exact attempt/idempotency/target查询并 reconcile；只有证明同一结果时补记，不能再执行。HTTP request、process spawn或任何 provider返回不具备权威查询时，CONSUMED后缺 durable result一律转 `AMBIGUOUS`并返回 typed inconclusive。

V1 的 `AMBIGUOUS` 是old lineage的terminal authority outcome：同token、新token、新invocation、同run或“fresh decision”都不得在old lineage重试。Invocation branch只关闭/revoke effect、Grant、Invocation与Activation context并推进其terminal-generation guard；它没有SelfDev run/reservation字段，也不伪造`BLOCKED` state。Promotion branch额外把reservation置`AMBIGUOUS_BLOCKED`、关闭pointer并通过唯一anchored transition把exact PROMOTING run转为terminal `FAILED`、fixed reason=`recovery_failed`。Branch-specific terminal marker/outbox在child issue前fail-closed；同一个CAS不允许ordinary branch写run字段或promotion branch省略run closure。

只有外部权威reconciliation、全部sibling terminal proof与signed lineage release完成后，人类才能显式启动全新run/activation/invocation lineage；它使用全新ids/nonces/heads/approvals并绑定exact reconciled dependency，绝不继续旧authority或推定old effect未发生。V1没有`ambiguousAcknowledged`或把prior AMBIGUOUS恢复执行的representation。Corpus在reserve/sign/publish/consume/OS-effect/result-write每个crash boundary以及AMBIGUOUS-vs-child-issue race fault-inject，证明最多一次token consumption、旧lineage后续issue/dispatch/effect=0。

### 19a.12 Size、count 与 closure limits

本节所有 `KiB/MiB` 都是 `1,024/1,048,576` bytes。下列上限同时应用于 incoming raw bytes 和 canonical re-encode result；先根据 endpoint/expected role 选择 limit，超限必须在 JSON parse、base64 decode、store allocation 或 artifact fetch 前拒绝。

| Root / subdocument | 最大 canonical/decoded bytes |
|---|---:|
| ActivationTokenPayload / InvocationDecisionProof / InvocationGrantPayload / Catalog JournalCheckpoint | 16 KiB each |
| BrokerCallTokenPayload | 8 KiB |
| AuthorityEnvelope（含 encoded payload container 与 signature） | 64 KiB |
| Promotion/Adoption/Enable ApprovalReceipt payload | 2 MiB each |
| Stage/Git/Completion receipt / CatalogEvent payload | 64 KiB each |
| SignatureEnvelope / ArtifactAuthorityEnvelope | 8 KiB each |
| CapabilityRevisionAllocationRecord | 32 KiB |
| Catalog head/allocator/fence/reservation/history snapshot与其他未单列的protected source record | 16 KiB each |
| HostBootstrapProfile / principal descriptor / verification command | 4 KiB each |
| persistent-host probe / human decision | 8 KiB / 32 KiB |
| SafeDisplay / SafeDisplay decision mapping | 1 MiB / 32 KiB |
| Human participant binding | 8 KiB |
| Principal binding / credential binding | 4 KiB each |
| PermissionTemplate / PermissionSpec / permission projection / sandbox requirements / SelfDevPromotionPlan / invocation input / candidate capability output / capability output value / broker request | 64 KiB each |
| Effective policy snapshot | 32 KiB |
| Catalog/Git effect plan | 16 KiB each |
| Verification environment | 8 KiB |
| Broker target | 32 KiB |
| SelfDev verification bundle / reviewer-isolation set | 256 KiB each |
| SelfDev verification context | 64 KiB |
| SelfDev run context | 128 KiB |
| SelfDev approval context | 16 KiB |
| PromotionApprovalConsumption | 32 KiB |
| SelfDev run-transition subject / promotion terminal failure | 16 KiB / 32 KiB |
| TransitionPrepared / transition materialization inputs | 2 MiB each |
| Approval-consumer permit / completion-worker permit payload | 16 KiB each |
| Promotion effect execution-permit subject / protected ledger record | 16 KiB each |
| Secret operand binding / per-invocation aggregate | 4 KiB / 64 KiB |
| Reconciled lineage dependency | 16 KiB |
| SelfDev run-journal event / anchor payload / checkpoint | 8 KiB each |
| SelfDev run-journal event/anchor/checkpoint InlineAuthorityEnvelope | 16 KiB each |
| Approval-consumer / completion-worker permit InlineAuthorityEnvelope | 32 KiB each |
| Ambiguity reconciliation or lineage release payload / InlineAuthorityEnvelope | 16 KiB / 32 KiB |
| Acceptance report | 128 KiB |
| Participant identity set | 128 KiB |
| Known limitations | 64 KiB |
| Rollback target | 8 KiB |
| Input/output embedded schema | 256 KiB each（另受 Manifest aggregate/root limits） |
| Embedded runtime closure | **512 KiB**（另受 BuildInputSet root limit） |
| RegistryMetaSchema bootstrap root | 64 KiB |
| CapabilityContractRegistry meta root | 1 MiB |
| SourceInputSet / BuildInputSet | 1 MiB each |
| ManifestPayload / BundleBindingPayload / CatalogAdoptionBinding | 1 MiB each |
| EvidenceSet / ProvenanceAttestation / CatalogVerificationEndorsement / CatalogEvidenceBinding | 2 MiB each |
| FileManifestPayload / SbomAttestation | 16 MiB each |
| Utf8Text decoded data | 32 KiB |
| 单个 SealedBlob raw nonsecret data | 64 MiB，且仍受 invocation/resource budget |
| 每个 fetched trust/key/revocation/identity/history/inclusion-proof record | 16 KiB |

Base64url/no-padding 的 encoded string length 只能按下式计算，不能使用“约 4/3”或 padded-base64 library length：

```text
B64URL_LEN(n) = 4 * floor(n / 3) + {0 if n mod 3 = 0; 2 if = 1; 3 if = 2}
```

对 decoded child `C`，`CanonicalBytesContainerV1` 的 byte length是将 `bytesBase64Url` 精确替换为 `B64URL_LEN(byte_length(C))` 个 ASCII chars、写入 decimal `size`、fixed 64-hex digest和 closed role后，按 Canonical JSON V1 计数得到的 `CONTAINER_LEN(role,C)`；不得只对 decoded bytes 做 limit check。对有 `m` 个 direct embedded children 的 parent `P`，定义 `FIXED_LEN(P)` 为把每个 child object 临时替换为单字节 JSON integer `0` 后的 canonical byte length减去 `m`，则：

```text
PARENT_LEN(P) = FIXED_LEN(P) + sum(CONTAINER_LEN(role_i, child_i))
```

该替换只用于 counting writer，不是合法 wire value。Implementation 必须在 allocation 前用 checked integer 预检 base64 text upper bound，decode 后检查 exact decoded size/digest，再用 counting writer/actual canonical encoder确认 `PARENT_LEN`。Parent root cap 永远是最终判定；达到 individual child max 不代表与其他 max child 合并后仍合法。

Embedded containment 另有三个不可互相替代的计数：`D(P)` 是所有 embedded descendant decoded canonical bytes 按 occurrence 的总和，`E(P)` 是这些 container 内实际 base64url string lengths 的总和，`N(P)` 是 parent 自身完整 canonical byte length。V1 caps 为：

| Parent | `D(P)` decoded aggregate | `E(P)` encoded-string aggregate | `N(P)` root |
|---|---:|---:|---:|
| BuildInputSet（1 个 runtime closure） | 512 KiB | 699,051 bytes | 1 MiB |
| ManifestPayload（最多 32×3 schema/template containers） | 512 KiB | 702 KiB | 1 MiB |
| CatalogEvidenceBinding（projection/requirements/optional plan descendants） | 256 KiB | 352 KiB | 2 MiB |
| SelfDevPromotionPlan（2 个 effect plans） | 32 KiB | 44 KiB | 64 KiB |
| EvidenceSet（environment + commands） | 1 MiB | 1,408 KiB | 2 MiB |
| CatalogVerificationEndorsement（§18 context/plan/evidence/identity/acceptance/limitations/rollback containers） | 1 MiB | 1,408 KiB | 2 MiB |
| ParticipantIdentitySet（最多64项的 binding containers） | 64 KiB | 88 KiB | 128 KiB |
| HumanParticipantBinding（2 个 binding containers） | 2 KiB | 2,732 bytes | 8 KiB |
| Promotion/Adoption/Enable ApprovalReceipt | 1,152 KiB | 1,572 KiB | 2 MiB |
| Stage/Git/Completion receipt或CatalogEvent | 32 KiB | 44 KiB | 64 KiB |
| PromotionApprovalConsumption（两个run anchor） | 16 KiB | 22 KiB | 32 KiB |
| TransitionPrepared（最大promotion approval materialization branch） | 1,152 KiB | 1,572 KiB | 2 MiB |
| SelfDev run-event/anchor/checkpoint InlineAuthorityEnvelope | 8 KiB | 10,923 bytes | 16 KiB |
| AmbiguityReconciliation / LineageRelease / worker-permit InlineAuthorityEnvelope | 16 KiB | 21,846 bytes | 32 KiB |

`D/E`按occurrence递归计数。Approval parent maxima为SafeDisplay1 MiB、HumanParticipant8 KiB、HumanDecision32 KiB，Promotion另含ApprovalContext16 KiB与pre/post anchor各8 KiB；aggregate D≤1,152 KiB/E≤1,572 KiB/N≤2 MiB。Generator锁exact overhead并构造三branch所有required fields存在、SafeDisplay 4,096 nodes/rendered256 KiB的fully-valid max及one-over。

`candidate-capability-output.v1` 的所有 `utf8-text-candidate.bytesBase64Url` decoded occurrence合计最多 **32 KiB**、encoded string合计最多 **44 KiB**（覆盖多 leaf 各自取整），root `N≤64 KiB`；base64 decode/allocation前先用 checked encoded upper bound，fully-valid at/over leaf aggregate与root各有独立 corpus。Candidate frame不是 protected CanonicalObjectRef，也不能进入 permission/evidence；它只存在 plugin→K0 result gate，成功后被 final K0 object替代。

Semantic embedded-container edge depth最多 **2**（如 Endorsement/CEB→plan→effect plan，或 InvocationDecisionProof→HumanParticipant→principal binding），每个 decoded document自身仍各受 JSON depth32。Mandatory `InlineAuthorityEnvelope.payload: AuthorityCanonicalPayloadV1`只是签名 transport wrapper：其 decoded/encoded bytes计 envelope `D/E/N`和allocation limit，但不计 semantic embedded edge；因此 human proof路径不是 depth3。Receipt/endorsement/event使用 detached envelope，不能作为 inline-depth示例。超任一 `D/E/N`都返回 `contract.limit-exceeded`。

InlineAuthorityEnvelope 恰有一个 payload container。Activation/Invocation payload 的 decoded cap 16 KiB，对应 base64 string最多 21,846 bytes；Broker 8 KiB 对应 10,923 bytes；checkpoint decoded cap 16 KiB。Envelope 中 payload container以外的 canonical bytes（包括 bounded key id/purpose/role、wrapper keys和 64-byte signature encoding）必须不超过 **2 KiB**，且完整 `N(envelope) ≤ 64 KiB`。64 KiB receipt/event和 2 MiB endorsement只使用 detached ≤8 KiB ArtifactAuthorityEnvelope，所以不存在“max payload塞入同大小 inline envelope”的路径。

Protected-store refs不计token N，但同scope decoded aggregate固定：activation profile+probe+principal≤20 KiB；invocation input+template+spec+display+policy+principal+decision proof+mapping+secret bindings≤2 MiB，其中secret bindings≤64 KiB；每effect target+request≤128 KiB。Ref declared size、role cap、aggregate均在读store前checked。

从任何CEB/CAB/receipt/event开始的一次 verification：

- unique fetched canonical artifact/control bytes、detached/inline envelope bytes、Catalog/SelfDev suffix+checkpoint+anchor/inclusion-proof bytes，以及**全部**publisher/K0/human/worker public-key、purpose/trust/revocation/identity-binding、policy/history/head/allocation/fence registry record bytes合计最多 **64 MiB**；每个individual source item先受本表/registry的expected-role专属cap（例如allocation record为32 KiB），只有未单列的protected source record使用16 KiB default，绝不能再叠加一个更小的隐式generic cap。仅byte budget可按verified typed key+exact bytes dedup；bundle raw files另受resource budget。
- Expanded occurrence计数最多 **100,000**，unique fetched item也最多100,000。每个syntactic ArtifactRef occurrence、non-null Catalog/SelfDev predecessor、detached/inline envelope obligation，以及**每一次**`VerificationSourcesV1` callback invocation都各计1；后者包括key/trust/revocation/identity/policy/head/allocation/fence/lease/permit/effect-ledger/terminal-marker/provider/reconciliation/release/dependency/checkpoint/anchor proof，不能只给artifact callback计数。即使相同bytes/cache命中也不减少occurrence；repeated subtree使用checked DP乘法累加，禁止先dedup后计数。
- Catalog predecessor suffix与SelfDev predecessor suffix各自有independent defense cap **32 edges**且不相加；checkpoint depth0、post events 1..32、33拒绝。每个root/event的local ArtifactRef+envelope+registry lookup另有defense cap32；predecessor edge不进入local counter。所有bytes/occurrences仍共享global caps。
- Defense cap不是“schema必然可达32”的声明。Registry generator在closed role/union graph上以field order、cardinality和role transition做checked dynamic programming，生成 `maxExpandedOccurrenceCountByRoleAndVariant` 与 `maxLocalLookupDepthByRoleAndVariant`；每个structurally reachable maximum M必须≤global/defense cap。Corpus的fully-valid fixture只构造到该variant真实M；`M+1`用closed cardinality/schema reject，counter=33另用instrumented verifier/fake bounded source测试limit path，禁止声称一个本地schema可构造fully-valid depth32，除非generated M恰为32。
- 所有加法/乘法/sequence/depth使用checked integer；overflow拒绝。先验证named cardinality与generated occurrence upper bound，再调用source；每次返回仍按expected role从raw bytes重解码/重算，禁止信任callback标签、redirect/symlink/network fallback。

Catalog journal每最多32个post-checkpoint events产生purpose-signed`catalog-journal-checkpoint.v1`并写protected monotonic anchor；SelfDev journal按§19a.8.2同样每≤32 events生成nominally distinct checkpoint。Recovery各自先验证current或specified historical monotonic checkpoint/inclusion proof，再走≤32 suffix；缺checkpoint、rollback/fork/wrong generation/33都fail closed。Shared corpus分别构造Catalog anchor+32/33与SelfDev anchor+32/33，并为每个role/variant构造generated structural M、M+1及globalbytes/occurrence exactly-at/one-over；不要求每个boundary event同时拥有不存在的local depth32结构。

Corpus 对每个 root、decoded child、`D/E/N`、closure bytes/ref/depth boundary 都要有 exactly-at 与 one-over recipe。Exactly-at 的 raw admission fixture 必须证明 parser 越过 size phase（即使随后因 strict schema 返回更后 phase），one-over 必须稳定返回 `contract.input-too-large`/`contract.limit-exceeded`；另为 schema 可构造的 child/aggregate提供 fully-valid at-limit case。测试必须断言 computed decoded length、`B64URL_LEN`、container/root length和 expected first-error，而不只断言 accept/reject。

### 19a.13 Verifier algorithm 与 API surface

#### 19a.13.1 Single normative machine registry

Prose不定义完整 valid byte language。ABI-00 必须建立单一 versioned `CapabilityContractRegistryV1`（canonical role=`capability-contract-registry.v1`），其 checked-in canonical bytes是 TS/Rust的唯一 machine schema source。Registry必须为本附录**每个** artifact、embedded/control、authority payload、head/projection、digest/ref、envelope、human/SafeDisplay/blob/value/permission AST variant记录：exact required/forbidden fields、field nominal type、closed enum/union discriminator、min/max/aggregate/depth/node limits、sort/dedup key、media-role pair、rank + **所有顶层及 embedded 子文档中的 named ArtifactRef cardinality/path**、signature/key purpose、derivation id/input/output、per-API contract error phase、production admission precondition/transaction order、case→error-enum dispatch和 scope/lifecycle。Registry中`effective-promotion-deadline-v1` exact inputs恰为四个signed timestamp field path（CatalogStage/Git plan lease deadline、PromotionApproval expiry、Endorsement expiry），唯一output是它们的`min`；issue-time policy只登记`maxPromotionLifetimeMs` bound与`policyEpoch` freshness，不是第五个timestamp、current policy bytes或checked-add input。特别地，EnableApprovalReceipt registry entry必须列出 `hostBootstrapProfile` 内三个 refs及其 CAB→CEB→Binding byte-equality，不能因 refs 被 base64 container 包裹而漏算；`persistentHostProbe`、SafeDisplay和HumanDecision的 ArtifactRef cardinality必须为0。

Registry自身使用 Canonical JSON V1、root cap 1 MiB，domain digest为 `CanonicalPayloadDigestV1(role="capability-contract-registry.v1")`；registry bytes **不含**自己的 digest，expected digest只固定在外部 corpus metadata。Bootstrap不能循环依赖 registry：ABI-00必须另 check in byte-exact、≤64 KiB `registry-meta-schema.v1.bin` 及外部 expected `RawContentDigestV1` 和 `CanonicalPayloadDigestV1(role="registry-meta-schema.v1")`，两者都从同一 exact bytes重算；内容固定 closed registry DSL 的 root fields `version,generatorVersion,roles,nominalTypes,mediaPairs,purposes,limits,derivations,errorPhases,contractErrorCodes,admissionErrorCodes,admissionPreconditions`和每种 record/schema-node union的 exact fields/bounds/sort rule。两个error enum每个literal必须恰有一个phase/transaction-order dispatch entry；未覆盖、多覆盖或prose-only admission code使bootstrap失败。Meta-schema bytes同样不含自己的 digest。Generator version literal=`capability-contract-generator-v1`。

唯一 build-time generator先要求 meta-schema `.bin` 与 compiled expected bytes/digest **完全相同**，再用该固定 DSL解析 ≤1 MiB registry，生成 TS和Rust两边的 types/tables/validators；Rust没有第二份手写 meta-schema parser。两种语言的 tiny bootstrap只实现 §19a.2 raw/canonical/hash、比较 external expected meta/registry digests和加载 generated table；它们对 BOM/duplicate/unknown DSL node/oversize/wrong generator/digest有共享 bootstrap golden/reject。Meta-schema bytes/digest、generator version或 bootstrap primitive变化必须独立 ABI review。Generated output带 registry digest；handwritten shadow schema不能成为 acceptance authority。Static test必须枚举 ClosedCanonicalRole/ClosedMediaRole/key purposes/error codes，证明 registry→TS→Rust无缺/多/field/order/limit drift，并对所有 derivation执行同一 input bytes→output bytes向量。任何仍只有 prose、ellipsis/open map/unknown field policy或未进入 registry的 role都使 ABI-00保持 DRAFT，不能 complete/frozen。

#### 19a.13.2 Required pure APIs

Private contract package 的 V1 最小 API 语义为：

```text
parseArtifactBytes(expectedSchemaRole, rawBytes, limits) -> StrictArtifact
parseControlBytes(expectedControlRole, rawBytes, limits) -> StrictControl
canonicalBytes(expectedRole, strictValue) -> bytes
domainSeparatedBytes(expectedRole, canonicalBytes) -> bytes
artifactRef(expectedMediaRole, expectedSchemaRole, canonicalBytes) -> ArtifactRefV1
verifyRef(expectedFieldContract, ref, fetchedBytes) -> StrictArtifact
verifyClosure(rootContract, sources:VerificationSourcesV1,
              context:VerificationContextV1) -> VerifiedClosure
buildDetachedSignaturePreimage(expectedRole, canonicalBytes) -> bytes
verifyDetachedSignature(expectedRole, canonicalBytes, envelope, trustedKey) -> VerifiedSignature
verifyInlineAuthorityEnvelope(expectedRole, payloadBytes, envelope,
  trustedKeyRecord:TrustedKeyRecordV1,
  trustRevocationSnapshot:TrustRevocationSnapshotV1) -> VerifiedAuthority
verifyArtifactAuthorityEnvelope(expectedFieldContract, ref, fetchedBytes, envelope,
  trustedKeyRecord:TrustedKeyRecordV1,
  trustRevocationSnapshot:TrustRevocationSnapshotV1) -> VerifiedAuthority
verifyProtectedCanonicalObjectBytes(expectedRole, ref, fetchedBytes,
  scopeSnapshot:ProtectedObjectScopeSnapshotV1) -> VerifiedCanonicalObjectClaimV1
```

这些API参数中的trust/scope类型不是caller可扩展interface。`VerificationKeyPurposeV1`恰为`{kind:"k0",keyPurpose:ClosedKeyPurposeV1,version:1}|{kind:"human",keyPurpose:HumanKeyPurposeV1,version:1}|{kind:"publisher",keyPurpose:"bundle-publisher",version:1}`。`TrustedKeyRecordV1` exact fields是`{algorithm:"ed25519",expiresAtMs,issuedAtMs,keyId,keyPurpose:VerificationKeyPurposeV1,publicKeyBase64Url,publicKeyFingerprint,registryEpoch,trustDomain,version:1}`；public key strict-decode为32 bytes且fingerprint从raw key重算，purpose必须匹配调用的expected endpoint。`TrustRevocationSnapshotV1` exact fields是`{currentRevocationHead:MonotonicRevocationHeadV1,expectedRevocationEpoch,expectedTrustEpoch,registryGeneration,version:1}`，其head/generation/epochs必须由`VerificationSourcesV1` exact history/current records重算，不能由envelope或caller自报。

`ProtectedObjectScopeSnapshotV1` exact fields是`{currentReadBudget:0|1,expectedObjectHandleId,expectedRole:ClosedEmbeddedRoleV1,expectedScopeId,expectedScopeKind:"activation"|"invocation"|"effect",observedAtMs,recordRevision,state:"SEALED",storeEpoch,version:1}`，来自K0 protected store的linearizable read。Pure verifier只比较它与ref/bytes，不改变budget。`VerifiedCanonicalObjectClaimV1`是non-authority internal result `{canonicalDigest:CanonicalPayloadDigestV1,canonicalSize,objectHandleId,recordRevision,role:ClosedEmbeddedRoleV1,scopeId,scopeKind,storeEpoch,version:1}`；它不含store capability、raw secret handle或consume permission。Operational layer只有在claim与same record revision仍current时才可参加更外层CAS。

`VerificationContextV1` exact fields是`{expectedPolicyEpoch,expectedRevocationEpoch,expectedTrustEpoch,limitsNoWiderThanRegistry,temporalContext:VerificationTemporalContextV1,version:1}`；current branch三expected epochs必须等于current fields，historical branch必须等于authenticated use source内签名的event-time epochs，terminal-reconciliation branch必须等于`originalUse`的event-time epochs而current reconciler/provider epochs只来自该temporal branch。任一caller limit大于registry cap拒绝，小于则作为更窄defense cap。`VerificationSourcesV1`是closed、read-only、side-effect-free/no-network capability object，恰含下列typed callbacks（名称与参数本身由registry生成）：

```text
artifactBytesByRef(ArtifactRefV1)
detachedArtifactAuthorityEnvelopeBytesByRef(ArtifactRefV1)
inlineAuthorityEnvelopeBytesByRoleAndDigest(ClosedAuthorityPayloadRoleV1, digest)
canonicalControlBytesByRoleAndDigest(ClosedEmbeddedRoleV1, digest)
protectedCanonicalObjectBytesByRef(CanonicalObjectRefV1)
catalogEventBytesByJournalDigest(JournalDigestV1)
catalogCheckpointAnchorProofBytes(CatalogCheckpointHeadV1)
selfDevEventBytesByJournalDigest(SelfDevRunJournalDigestV1)
selfDevCheckpointAnchorProofBytes(SelfDevCheckpointHeadV1)
k0TrustedKeyRecordBytes(keyId, ClosedKeyPurposeV1)
publisherTrustedKeyRecordBytes(keyId, literalPurpose="bundle-publisher")
humanTrustedKeyRecordBytes(keyId, HumanKeyPurposeV1)
trustHistoryRecordBytes(trustEpoch)
currentRevocationHeadBytes(scope)
revocationRecordBytes(revocationEpoch, keyOrIdentityId)
identityBindingRecordBytes(expectedIdentityRole, recordId)
policyHistoryRecordBytes(policyEpoch)
catalogHeadSnapshotBytes(expectedHeadKey)
selfDevRunHeadSnapshotBytes(runId)
capabilityRevisionAllocationBytes(allocationId)
fenceReservationHistoryBytes(capabilityId, reservationId)
leasePermitRecordBytes(permitId)
effectLedgerRecordBytes(lineageId, effectId)
lineageTerminalMarkerBytes(lineageKind, lineageId)
providerAuthoritativeStateBytes(reconciliationAdapterId, targetCanonicalDigest)
reconciliationPayloadAndEnvelopeBytes(digest)
lineageReleasePayloadAndEnvelopeBytes(digest)
reconciledLineageDependencyBytesByRef(
  CanonicalObjectRefV1(role="reconciled-lineage-dependency.v1"))
```

Each callback returns the registry-specified bounded byte list: exact-one roles require one, optional roles 0..1, detached/reconciliation candidates reject 0 or >1; callbacks may not follow path/URL/symlink or mutate state. Every returned occurrence, including duplicate/conflicting candidates, is charged lookup/byte budget before parsing; callback labels are untrusted and bytes are reparsed/recanonicalized under caller-expected role. Unknown callback/source unavailable fails closed. Pure artifact DAG verification and dynamic current-authority/head/lease/reconciliation checks are separate internal phases, but top-level `verifyClosure` must run both required phases according to root contract so caller cannot omit one.

`verifyClosure` 顺序与 §19a.2 registry一致：先 expected field role/media/ref syntax/declared size → callback取得exact bytes → raw-byte admission → canonical re-encode equality → **strict node schema** → domain digest/ref equality → rank + visiting set → named cardinality → recursive children → cross-node same-closure checks → signature/trust/current revocation → signed-artifact authority pairing → temporal/dynamic source checks → verified result。这样同 child同时 schema-invalid + digest-mismatch稳定先返回 schema-invalid；invalid ref/role根本不fetch child。每个 `ClosedSignedArtifactSchemaRoleV1`必须从detached callback取得exact one envelope并按table purpose验证。Lookup缺失/多个、ref_A/envelope_B、purpose/key/trust mismatch或source bypass均拒绝且计budget，不返回partial-trusted node。

`verifyProtectedCanonicalObjectBytes`只验证caller提供的immutable bytes/ref/scope snapshot并返回不可执行claim；它不接store handle、不读写`readBudget`。K0/Rust operational layer独占seal/read/`readBudget:1→0`及multi-ref atomic consume CAS，且不从private contract package export。把pure API连接到mutable protected store、contract verifier自行消费authority或只传purpose string而无key/trust/revocation bytes均是import/behavioral fence failure。

#### 19a.13.3 Package and import boundary

ABI-00 实现目标是新的 **private** `packages/capability-contract`：

- `package.json.private=true`，不发布、不决定最终 brand/package scope。
- `canonical`、`artifact`、`manifest`、`corpus` 是纯 data/crypto/schema 层，不 import plugin runtime、native bridge、CLI/composition、network/fs/process service。
- `authority` 是单独 internal subpath，不从 root barrel 重导出。`packages/plugin-sdk` **MUST NOT** import `authority`、issuer/key store、Catalog reducer、ActivationToken、InvocationGrant 或 BrokerCallToken。
- `authority` 只导出 strict data types、`buildDetachedSignaturePreimage` 和 pure verifier。该 preimage API只接受 expected closed role + public canonical bytes并返回 domain-separated bytes；它不接受 key/seed/secret/signing handle且不产生 signature。Root/internal exports、package packlist与 production dependency graph按**行为**禁止任何 callable（无论符号名）接受 private key/seed/secret signing handle、加载/变更 key store、产生 signature、mint/issue receipt/token或构建 privileged authority；命名扫描只是辅助，不能把签名函数改名绕过。Corpus 的签名生成器和固定 private test keys只能存在 test-only workspace target，不能从 package exports/packlist/production graph可达。未来 K0 issuer必须位于独立 protected package/crate，并只能消费这里的 pure preimage/verifier contract；contract package不是通用签权库。
- ABI-00 阶段，production plugin-runtime/native/CLI 也 **MUST NOT** import contract package 的任何 subpath；只有 contract tests 和独立 Rust fixture verifier 可消费 corpus。接 production 的最早 phase 是 PK-P0 fixture enforcement，activation wiring 仍要等 CAT + ABI-RUNTIME。
- 未来 public SDK 只可消费审查后的 public manifest/contribution schema 或 generated DTO；不得因复用类型而把 authority issuer/verifier 带入不可信 plugin。

Import-boundary test MUST 检查 dependency graph、root/subpath exports、packed file list和 production reachability，而不只检查 source string alias；另以 static symbol scan + behavioral type/runtime probe证明除 pure `buildDetachedSignaturePreimage` 外，任何可接收 private signing material/handle或产生 signature/authority的 API都只能从 test target到达。ABI-00 完成时 production P0-00 deny-only path 和 activation=0 证据必须仍通过。

### 19a.14 Shared TS/Rust golden and reject corpus

TS 和 Rust 不得各维护一份“等价” fixture。单一 corpus 位于 `packages/capability-contract/fixtures/v1/`，分两层：

1. 小型 raw-byte cases 全部 check in 为 immutable `.bin`，包括看起来像 JSON 的 valid/invalid/canonical payload；contract bytes禁止`.json`。`SmallCaseMetadataV1` exact common fields是`{caseId,caseKind:"contract"|"admission",expectedMediaRole:null|ClosedMediaRoleV1,expectedRole:ClosedCanonicalRoleV1,inputPath,version:1}`；`expectation`恰为`{kind:"accept",canonicalHex,domainHex,digestExpectation:{kind:"none"}|{kind:"typed",digestRole,value},signatureExpectation:{kind:"none"}|{kind:"exact",keyPurpose,signatureBase64Url},version:1}`或`{kind:"reject",errorCode,errorEnum:"CapabilityContractErrorCodeV1"|"CapabilityAdmissionErrorCodeV1",phase,version:1}`。Accept/reject字段互斥；contract/admission必须分别选择对应enum。
2. 16/64 MiB、100k refs和各 root/child/`D/E/N` boundary使用 `large-recipes.v1.ndjson`。`LargeRecipeV1` common exact fields是`{algorithmId,caseId,expectedByteLength,expectedRawContentDigest:RawContentDigestV1,expectedResult,generatorVersion:"capability-large-fixture-generator-v1",parameters,version:1}`。`algorithmId/parameters` closed union恰为：`repeat-byte-v1{byte,count}`、`canonical-object-padding-v1{expectedRole,padField,padScalar,count}`、`artifact-closure-chain-v1{rootRole,edgeCount,checkpointCadence}`、`embedded-aggregate-v1{childRole,occurrences,payloadBytes,parentRole}`、`expanded-occurrence-dag-v1{branching,depth,leafRole}`、`safe-display-tree-v1{branch,containerNodes,scalarNodes,renderedBytes,secretEntries}`、`role-cardinality-v1{fieldPath,itemRole,itemCount,rootRole}`；每分支仅允许列出的fields和registry bounds。`expectedResult`恰为`{kind:"accept",expectedCanonicalPayloadDigest}`或`{kind:"reject",errorCode,errorEnum,phase}`。Independent generator不得 import/reuse contract code；algorithm迭代/ordering/padding bytes由registry固定。CI只生成一次到temp，核对length/raw SHA后让TS/Rust读取同一file。

所有metadata/recipe `.ndjson` 每行恰为一份Canonical JSON V1 bytes加一个ASCII LF，文件包括最后一行后也**恰有一个final LF**；无blank line/CRLF/BOM。记录按`caseId` bytes严格排序unique。`inputPath`使用portable relative ASCII path grammar，只允许`.bin`/`.ndjson` extension、禁止absolute/`..`/empty/repeated segment、symlink与fixture-root escape；referenced file exact-one。`.gitattributes`必须同时含`packages/capability-contract/fixtures/**/*.bin -text`和`packages/capability-contract/fixtures/**/*.ndjson text eol=lf`。Duplicate/order drift、CRLF/no-final-LF/double-final-blank、path traversal/symlink/unknown algorithm或cross-branch parameter在generator运行前拒绝。Generator/version/recipe digest进入bootstrap review。

Test failure只输出 case id、bounded phase metadata和 test-only expected/observed fixture digest，不输出 raw bytes。Large recipe的 exactly-at case必须越过对应 limit phase，one-over稳定命中指定首错；small/large corpus都执行两个 enum/phase registry drift检查。

Golden corpus 至少包含：

- Registry/meta-schema bootstrap、每个 artifact/embedded/control/authority/meta role、每个 union/AST/head/projection variant的最小与最大可构造 valid bytes。
- §19a.3 byte vector、role-separated equal payload digest difference、Ed25519/base64url 确定向量。
- Canonically equivalent composed/decomposed Unicode strings 都按原 UTF-8 接受且产生不同 typed digest；decision-bearing fields/path 仍只接受各自 ASCII grammar。
- IdentityCommitment vectors覆盖跨issuer/role/session的同一stable tuple相等、principal与credential purpose prefix必然不同、tuple field-swap、ambiguous concatenation、issuer-local id误入preimage与domain-generation rotation/revocation。
- 完整 K1/K2/K3 closure，含 same publisher signature set、distinct signed CatalogVerificationEndorsement、§18 performed+designated Participant/Acceptance/Isolation/limitations/rollback containers、全部 run roles/purpose/session/context与 stable principal/credential commitments、K3 plan/Git exact base transaction、CEB → Completion → CAB → adoption/enable → Activation lineage。
- 每个 CapabilityValueSchema/value（含 control-string enum member 16,384-byte exactly-at）、candidate inline output→NONSECRET final Utf8Text transform、output-secret destroy、Permission AST/broker bounds+actual variant、requested/effective exact effectId set + per-effect narrowing、四种 HumanDecision branch与 human/auto InvocationDecisionProof、pure `effects:[]`、nonempty derivation、四种 `SafeDisplaySubjectV1` canonical bytes/HMAC fingerprint、SafeDisplay path/container/secret-operand mapping、UI token后 display derivation、HostBootstrap `net=false`。
- 每个 BuildInputSet/Process `ExecutableBindingV1` target的 reconstruct/no-follow/opened-identity正向向量；Activation context → multiple Invocation contexts → multiple exact BrokerCallTokens 的 typed nonce/idempotency、sidecar freshness、budget/expiry和 crash outcome正向向量。
- Candidate v2与 active v1 side-by-side、`DISCOVERED` allocator唯一分配 monotonic capabilityRevision→reservation复用→release→later DISCOVERED分配更大 revision、initial-enable复用 adoption revision、DISABLED restore/re-enable先分配 fresh revision、atomic enable swap、new-revision fresh-authority rollback v2→v1、SemVer normal-upgrade watermark，以及 result projection finalize后派生 head digest（event bytes无 self digest）。
- `effective-promotion-deadline-v1` 每个可能 minimum source的 golden、`nowMs == effectivePromotionDeadlineMs` success boundary，以及 next millisecond fail；Completion-vs-expiry supersede interleaving必须证明同一 store只有一个 winner且 absence proof线性一致。
- SelfDev anchored golden穷举ENTER_AWAITING、APPROVAL、CONSUMPTION、COMPLETION、EXPIRED failure、AMBIGUOUS failure：验证actor authorization→intent→trusted-time event→genesis/rollover checkpoint→anchor→final artifact单向依赖、pre/post anchor各一次、consumer/completion permits与stage/git execution-permit subjects、worker/finalizer identities分离，以及PREPARED/OPEN/ANCHORED/CANCELLED/FINALIZED response-lost recovery。包含seq0 checkpoint、suffix32、seq33 rollover、prepared-before/deadline后anchor CANCELLED、timely anchor后过期FINALIZED、cancel-vs-late-commit、key unavailable/rotate/revoke各边界。
- Reconciliation golden含ordinary/promotion三effectKind result/evidence namespaces、一个ambiguous sibling加normal success/failure/never-issued siblings的exhaustive release、two-effect late-outcome race、FAILED run byte-identical release、fresh dependency A/B protected refs，以及PROVEN_OCCURRED exact registered adapter/HTTP-process永久deny。
- SemVer/content-authority golden含超JS-safe-int numeric identifiers、numeric/text prerelease排序、build-metadata precedence相等、跨domain same-version Binding conflict、failed-before-enable不污染、rollback后比较旧high watermark，以及authority expiry→quarantine→same content fresh generation→authority-refresh enable。
- Closure large recipe以 checkpoint anchor depth0 + 32 post-checkpoint events构造 journal predecessor depth32，并让每个 boundary event artifact/authority/trust depth32；另分别构造第33个 post-checkpoint event、event closure=33及 global bytes/occurrences one-over。
- Production admission matrix覆盖每个 local precondition与 authenticated transaction fault组合，证明 fence→store→minimum-resource和 state→deadline→replay→resource exact precedence、选用 `CapabilityAdmissionErrorCodeV1`，且 preflight失败时 payload read/parse/fetch、nonce consume、budget reservation与 state mutation全为0。

Reject corpus 至少包含：

| 类别 | 必须拒绝的代表向量 |
|---|---|
| Raw/canonical | BOM、invalid/overlong UTF-8、duplicate/unknown key、whitespace/order drift、float/exponent/-0/unsafe int、lone surrogate/C0/C1/NUL/noncharacter/bidi、任何偷偷 normalize/case-fold 的实现、depth/size overflow |
| Domain/digest | same bytes different role被混用、wrong length endian、uppercase/short digest、raw/external/canonical type confusion、outer-only digest trust、registry self-digest/meta bootstrap drift |
| Role graph | unknown/illegal media pair、wrong named role、missing/duplicate/cardinality overflow、rank increase/equal、direct/indirect/self cycle、reverse ref、Catalog back-reference |
| FileManifest | 非 portable-ASCII/reserved DOS/trailing-dot path、ASCII-case-fold duplicate、prefix conflict、Manifest 自报/错 target filesystem policy、Binding/Profile/Evidence policy mismatch、partial/extra file、size/content/mode mismatch、symlink/hardlink/device/FIFO/socket/reparse、entrypoint absent |
| Signature/closure | padded/noncanonical base64、wrong expected domain/key purpose、human/K0/publisher same-key alias、duplicate signer、revoked signer、mixed closure、nested-ref smuggling、effect plan偷藏 binding ref、Enable profile nested build/binding/file ref substitution、SafeDisplay/HumanDecision 偷藏 CEB/CAB ref、typed subject wrong-role/digest substitution、`ref_A + envelope_B`；`VerificationSourcesV1` fake source缺callback、返回0或>1、wrong-role标签、oversize trust/key/history bytes、K0/publisher/human source互换、callback尝试side effect/network/path fallback、绕过provider/lease/ledger/terminal/reconciliation source或漏计callback budget |
| Output endorsement | self-asserted pass/clean outputs、missing/expired/cross-purpose endorsement、mixed output refs、performed/designated run role缺失、participant/trust-record drift、reissued id/null key掩盖相同 stable principal/credential commitment、same-principal reviewer、non-pass acceptance、env-A/Evidence-env-B、suite/limitation id drift、limitations/rollback strategy replacement |
| Embedded/value/permission | digest/role/size/bytes mismatch、ArtifactRef代替 embedded bytes、unknown tagged variant/field/operator、16,385-byte control-string enum member、schema node/depth overflow、direction violation、data bytes/blobId/handleId影响target/argv、requested effect被drop/新增、per-effect target或secret operand变化、PermissionSpec或 UI bounds/actual回指 mapping/SafeDisplay、meet widening、missing pure template |
| SelfDev/Git | plan back-reference、binding/capability/base/candidate/revision substitution、bundle/verification/plan/Git `baseRef`不等或 baseRevision/baseSha/parent/verifyBase namespace/algorithm不等、source-tree/output provenance gap、object-format/OID/raw-payload/promotion-ref substitution、非原子 ref create、reservation expiry短于/长于 exact derived deadline、任一 plan/approval/endorsement/policy expiry或 runtime deadline substitution、at+1 deadline execution、receipt cross-binding |
| Anchored transition | intent含future event/anchor/receipt、event subject hash含post-anchor final record、wrong actor/permit/finalizer、consumer与PROMOTING worker state/role swap、capability fence与run fence swap、PREPARED materialization bytes缺失/漂移、caller timestamp、checkpoint wrong sequence/run/store/generation、suffix33未rollover、OPEN late commit越过CANCELLED、ANCHORED后依赖ephemeral signer、old head在FINALIZED前被消费、Stage/Git伪造PROMOTING→PROMOTING或release伪造FAILED→FAILED |
| Catalog/human | promotion approval复用于 adoption/enable、CAB改 origin/trust、K3缺 completion、K1/K2携 completion、stale Candidate/Record/Slot head、capabilityRevision在 reservation二次取 next/复用/降低/与 plan/receipt drift、initial enable错误分配新 revision、DISABLED re-enable/rollback复用旧 revision、completion未 release、supersede无同事务 absence proof或旧 history阻断 later revision、normal SemVer不递增、rollback降低 revision/复用旧 enable proof、event result self-digest、upgrade覆盖 active slot、K0 issuer冒充 human、auto-policy proof携 challenge/human fields、invocation使用 receipt branch/field、invocation decision digest/head/nonce/expiry substitution或跨 invocation replay |
| Reconciliation/SemVer | generic reconciliation digest/namespace/status、broker/catalog/git branch字段互换、single effect自行release、漏sibling、normal terminal伪造ambiguity record、release与late outcome双赢、post-terminal FAILED stateVersion变化、missing/wrong dependency或A/B handle复用、same HTTP/process semantic retry、caller mode label、超safe-int转Number、build metadata冒充precedence increase、same full version跨domain换Binding、failed candidate污染watermark/index、expired generationin-place refresh |
| Authority | HostBootstrap `net=true`/未知 network field/workspace path、receipt/head/epoch/probe mismatch、parent digest无 context、sidecar handle跨 envelope、protected ref/store epoch mismatch、decision proof/input/template/spec/policy/principal/mapping mismatch、grant widening |
| Data/secret | multiline/candidate aggregate truncation、noncanonical base64、plugin自报 final/NONSECRET、guard unknown仍 publish、secret output转 handle、inline/blob secret raw digest oracle、blob TOCTOU/replay、SecretHandle被读取/导出 |
| Broker | sibling target/op/port/path/query/header value/secret operand、HTTP forbidden/auth header或自动 redirect、ExecutableBinding logicalId/target/toolchain/path/digest/size/mode substitution、symlink/reparse/PATH fallback/launch TOCTOU、UI challenge subject drift或 result授权另一 effect、request mutation、budget overflow、named nonce/idempotency跨类型、token replay/race/expiry/revocation、idempotency cross-invocation、TS allow伪造、各 crash boundary与 AMBIGUOUS 后同/new token/invocation/run retry或 ack 恢复 authority |
| SafeDisplay | raw secret/handle、path未编码、field swap、absent/null、array/container boundary、escaped/raw length错、SafeDisplaySubject wrong discriminator/extra/omitted digest、HMAC只取单 digest/错误顺序/加入 final SafeDisplay digest、different PermissionSpec same decision bytes、alias/fingerprint/binding-id collision、同 kind/scope sibling handle换 effect、mapping A/B handle复用或 subject/digest drift |
| Contract error precedence | oversize+BOM、syntax+duplicate、schema+digest mismatch、mixed closure+bad signature、bad signature+authority，TS/Rust `CapabilityContractErrorCodeV1`首错不一致 |
| Admission precedence | fence closed + malformed/oversized payload必须先返回 `admission.production-fence-closed`且 payload read/parse/fetch=0；store-down+resource-low按 store先；authenticated state+deadline+replay+resource multi-fault按固定 transaction order且失败 mutation/reservation=0；返回 contract enum或 unknown code均拒绝 |
| Production fence | contract fixture存在时 legacy install/load/startup仍 activation=0；fence closed + attacker payload不触发 read/parse/fetch；任何 production runtime/native import、issuer/sign/mint/key-store export/packlist reachability或 hidden test authority都失败 |

两种语言对每个 case 必须产生同一 accept/reject 结果、canonical bytes/digest，以及 metadata/registry指定的同一 exact首错：`caseKind="contract"` 只能返回 `CapabilityContractErrorCodeV1`，`caseKind="admission"` 只能返回 `CapabilityAdmissionErrorCodeV1`（都不只比较 family）。某一语言选错 enum或“更宽松”时不取并集，而是两者 fail closed 并修正实现/合同。

### 19a.15 ABI-00 exit gate

ABI-00 只有在以下条件同时成立时才可标 complete：

1. Bootstrap meta-schema + single registry 已为每个 closed role/union/derivation、`CapabilityContractErrorCodeV1` phase和 `CapabilityAdmissionErrorCodeV1` precondition/transaction order生成 TS/Rust types/tables/validators；Canonical/domain/ContractStrictPureEd25519 golden byte-for-byte一致，所有 raw-byte/strict-signature/admission-preflight reject fail closed，未生成的 prose-only role=0。
2. Closed media/schema pair、具名上游基数、rank/visiting set、detached artifact authority pairing和 closure/journal budgets已转为 strict verifier；direct/indirect/self digest cycle=0，Catalog event只携 result projection，finalize后才派生带 new event digest的 materialized head。
3. Manifest内嵌 input/output/permission bytes+digest；portable-ASCII FileManifest只有 bounded regular files并绑定 closed filesystem policy；CEB绑定 same Binding/signatures/Evidence/Provenance/SBOM和 distinct signed CatalogVerificationEndorsement，且 endorsement完整覆盖 §18 verification context/plan/participant/independent acceptance/isolation/limitations/rollback bytes。
4. K3唯一 plan先进入 endorsement、CEB逐字复用且无 back-reference；完整 performed/designated identity set与 stable commitments不可由 reissued id/null key降级；source candidate→verified build output→Git tree/OID/ref transaction可重算且 bundle/verification/plan/Git base ref/object exact equality；promotion/adoption/enable receipts与 fresh human decisions完全分离。Monotonic capabilityRevision只在 DISCOVERED/new restore allocation一次并贯穿 candidate/reservation/plan/receipt/event，completion release允许 later revision，initial enable复用 adoption revision而 DISABLED restore必须 fresh revision，rollback不降 revision，SemVer normal-upgrade/rollback policy固定；`effective-promotion-deadline-v1`使 reservation/Stage/Git/Completion无 deadline extension。CAB保留 origin/source trust并显式增加 target installation domain，三头支持 side-by-side upgrade与 fresh-authority rollback。
5. HostBootstrap net literal false；BuildInputSet `ExecutableBindingV1`与 Rust no-follow identity-pinned process launch、sealed nonsecret text/blob与 opaque secret handle边界、protected context/object refs、effective policy snapshot、InvocationDecisionProof、requested/effective exact effect set、PermissionSpec无 display/mapping backedge、Activation→Invocation→Broker lineage、UI post-token display和 SafeDisplay mapping已冻结。`AMBIGUOUS` 对 current lineage/run terminal且没有 ack 恢复 authority。
6. 每个 root/child/embedded `D/E/N` 及 global closure bytes/count有 exactly-at/one-over shared recipe；journal predecessor和 per-event artifact/authority/trust depth分别为32并有 combined boundary。TS/Rust读取同一生成 bytes并返回同一 exact首错 code。
7. `packages/capability-contract`保持 private/pure/verifier-only，plugin-sdk无 authority dependency；除 pure `buildDetachedSignaturePreimage` 外，exports/packlist/production graph无接受 signing material/handle或产生 signature/issuer/mint/key-store authority的行为，production runtime/native/CLI无 contract import；test signer不可达 production。
8. P0-00 production kill switch仍在，legacy/local/registry install/load/startup activation=0；ABI-00不能作为 reopen理由。
9. ABI-00 evidence manifest必须列出 BRAND-VERIFY 的 exact branded-SHA rerun set：bootstrap meta-schema/registry digests与 generator、generated TS/Rust validators + 完整 corpus、ContractStrictPureEd25519 dependency/feature lock、private package export/packlist/dependency/import/behavioral signing fence，以及 SD0/P0/CAT/platform/docs/config/event gates；pre-brand通过结果不得移作 branded acceptance。

这个 exit 只为 PK-P0 和 CAT 提供稳定 fixture，不表示 plugin runtime、Rust enforcement、Catalog 或 Self-Development 已交付。Production activation 的重开仍依赖 PK-P0 + CAT + ABI-RUNTIME 的独立 review/human gate。

---

## 变更日志

| 日期 | 变更 |
|---|---|
| 2026-08-21 | FIX3：冻结四源promotion deadline、principal/credential purpose-separated commitments、exact Git object/ref bytes、SelfDev PREPARED→ANCHORED→FINALIZED与checkpoint、worker/finalizer/fence分离、all-sibling reconciliation dependency、content/authority-generation Catalog状态、exhaustive SafeDisplay/secret binding、three-mode VerificationSources及可构造limits/corpus |
| 2026-08-21 | FIX2：关闭 UI/mapping backedge、冻结完整 K3 performed/designated identity commitments、ExecutableBinding/process identity、exact effect set、AMBIGUOUS terminal、Git base equality、monotonic capabilityRevision/release/SemVer、双 traversal depth、typed nonce、BRAND-VERIFY 与 behavioral signing fence |
| 2026-08-21 | ABI-00 review draft：冻结 raw-byte canonical JSON/domain/strict signature、single machine registry、closed-role DAG/cardinality、signed output endorsement、embedded schemas/templates/唯一 K3 plan、CEB/CAB/三流 Catalog heads、protected authority lineage/data carriers、limits、verifier-only package fence与 TS/Rust corpus；保持 P0-00 关闭，等待独立 review |
