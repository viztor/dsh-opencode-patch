/**
 * The one builder for this plugin's remote contracts, in a module both bundles
 * may import.
 *
 * A contract is a namespace and its methods: each method's parameters and the
 * value it answers, each value a parser. Everything the Typert gateway reads is
 * DERIVED from that: the descriptors the client mounts (ids, the one wire name
 * per parameter, `acceptsUndefined` on an optional one only), the codecs, and
 * the method list the host's Remote marker carries (`markRemote` in
 * `src/host/remote.ts`). They were three hand-written literals per remote, and
 * a remote whose descriptor was missing reached the browser as "unavailable".
 *
 * Type-only imports from the protocol package, and nothing host-only, so the
 * client bundle may load it.
 *
 * @module dsh-opencode-patch/contracts/remote
 */

import type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol";

/** The npm package every descriptor id and codec type symbol is under. */
export const REMOTE_PACKAGE = "dsh-opencode-patch";

/**
 * Parse one boundary value. A throw and an `undefined` answer both mean "not
 * one": the purge and store parsers answer `undefined`, the usage parsers throw.
 */
export type RemoteParse<Value> = (value: unknown) => Value | undefined;

/** One wire codec, in the shape the gateway reads: one parser behind both doors. */
export interface RemoteValue<Value> {
  readonly create: () => { readonly parse: RemoteParse<Value> };
  readonly mode: "strict";
  readonly schema: { readonly parse: RemoteParse<Value> };
  readonly typeSymbol: string;
}

/**
 * The codec for one value type.
 *
 * @param type - the type's name, under {@link REMOTE_PACKAGE}.
 * @param parse - the contract's parser, behind both doors.
 * @returns a fresh codec.
 */
export const remoteValue = <Value>(
  type: string,
  parse: RemoteParse<Value>
): RemoteValue<Value> => ({
  create: () => ({ parse }),
  mode: "strict",
  schema: { parse },
  typeSymbol: `${REMOTE_PACKAGE}#${type}`,
});

/** One parameter: its name (also its wire name) and its value. */
export interface RemoteParameter {
  readonly name: string;
  readonly value: RemoteValue<unknown>;
  /** The whole argument may be absent on the wire. */
  readonly optional?: true;
}

/** One method: its parameters, in order, and the value it answers. */
export interface RemoteMethod<Value> {
  readonly parameters?: readonly RemoteParameter[];
  readonly result: RemoteValue<Value>;
}

/** What a contract is, to a reader of its methods. */
export interface RemoteContractOf<
  Methods extends Readonly<Record<string, RemoteMethod<unknown>>>,
> {
  readonly namespace: string;
  readonly methods: Methods;
}

/** A contract, and the contribution the client mounts for it. */
export interface DefinedRemote<
  Methods extends Readonly<Record<string, RemoteMethod<unknown>>>,
>
  extends RemoteContractOf<Methods>, TypertRemoteContribution {
  readonly descriptors: readonly InvocationDescriptor[];
  readonly package: typeof REMOTE_PACKAGE;
}

/** One parameter's descriptor; no `acceptsUndefined` key on a required one. */
const parameterDescriptor = ({
  name,
  optional,
  value,
}: RemoteParameter): InvocationParameterDescriptor => ({
  ...(optional === true ? { acceptsUndefined: true } : {}),
  codec: value,
  name,
  source: "json",
  wire: name,
});

/**
 * Define a remote: the namespace, and its methods in the order they are listed.
 *
 * @param namespace - the wire namespace, which is also the service key.
 * @param methods - each method's parameters and result.
 * @returns the contract, carrying its derived descriptors.
 */
export const defineRemote = <
  const Methods extends Readonly<Record<string, RemoteMethod<unknown>>>,
>(
  namespace: string,
  methods: Methods
): DefinedRemote<Methods> => ({
  descriptors: Object.entries<RemoteMethod<unknown>>(methods).map(
    ([method, { parameters = [], result }]): InvocationDescriptor => ({
      id: `${REMOTE_PACKAGE}#${namespace}/${method}`,
      invocation: { kind: "direct" },
      method,
      namespace,
      parameters: parameters.map(parameterDescriptor),
      result,
      service: namespace,
    })
  ),
  methods,
  namespace,
  package: REMOTE_PACKAGE,
});
