# Networking (`hle-net.ts`)

Covers the PSP networking libraries: `sceNet`, `sceNetInet`, `sceNetApctl`, `sceNetAdhoc` (and `Adhocctl` / `AdhocMatching`), `sceNetResolver`, `sceNp` (and `sceNp2`), `sceWlan`, `sceHttp` / `sceHttps`, `sceSsl`, `sceParseHttpHeader`, `sceParseUri`, `sceOpenPSID`, and `scePauth`.

Networking is not implemented. Every function in this module is registered as a no-op stub (over 300 of them), so a game that probes for network features gets a benign default and continues, rather than crashing on an unimplemented call. There are no real socket, ad-hoc, or HTTP operations behind these calls (the browser has no raw sockets).

Practically, this means single-player titles boot and run normally, while online and ad-hoc multiplayer features do nothing.

## How the stubs work

There are no real `kernel.register()` handlers here, only `kernel.stub()` calls. A stub takes no action, tracks its call count in the debug panel, and returns a fixed value. Most stubs return `0` (success). A handful return `1`, because games treat `0` from those particular calls as "not ready" and would spin or bail. The Returns column below lists each one.

No C signatures are documented per function because none of these handlers read or write their arguments. The argument layout is the standard MIPS O32 ABI (`a0-a3` in `$4-$7`); the stub ignores all of it and just sets the return value in `v0`.

## `sceHttp` / `sceHttps`

HTTP(S) client. Every call below is a no-op stub. Connection handles, requests, headers, cookies, caching, and timeouts all do nothing, and no data is ever sent or received.

| Function | Returns |
| --- | --- |
| `sceHttpAbortRequest` | 0 |
| `sceHttpAddCookie` | 1 |
| `sceHttpAddExtraHeader` | 1 |
| `sceHttpCreateConnectionWithURL` | 1 |
| `sceHttpCreateRequest` | 1 |
| `sceHttpCreateRequestWithURL` | 1 |
| `sceHttpCreateTemplate` | 1 |
| `sceHttpDeleteConnection` | 0 |
| `sceHttpDeleteHeader` | 0 |
| `sceHttpDeleteRequest` | 0 |
| `sceHttpDeleteTemplate` | 0 |
| `sceHttpDisableAuth` | 0 |
| `sceHttpDisableCache` | 0 |
| `sceHttpDisableCookie` | 0 |
| `sceHttpDisableKeepAlive` | 0 |
| `sceHttpDisableRedirect` | 0 |
| `sceHttpEnableAuth` | 0 |
| `sceHttpEnableCache` | 0 |
| `sceHttpEnableCookie` | 0 |
| `sceHttpEnableKeepAlive` | 0 |
| `sceHttpEnableRedirect` | 0 |
| `sceHttpEnd` | 0 |
| `sceHttpEndCache` | 0 |
| `sceHttpGetAllHeader` | 0 |
| `sceHttpGetContentLength` | 0 |
| `sceHttpGetNetworkErrno` | 0 |
| `sceHttpGetNetworkPspError` | 0 |
| `sceHttpGetProxy` | 0 |
| `sceHttpGetStatusCode` | 0 |
| `sceHttpInit` | 0 |
| `sceHttpInitCache` | 1 |
| `sceHttpReadData` | 1 |
| `sceHttpSaveSystemCookie` | 0 |
| `sceHttpSendRequest` | 0 |
| `sceHttpSetAuthInfoCB` | 0 |
| `sceHttpSetAuthInfoCallback` | 0 |
| `sceHttpSetConnectTimeOut` | 1 |
| `sceHttpSetMallocFunction` | 1 |
| `sceHttpSetProxy` | 0 |
| `sceHttpSetRecvTimeOut` | 0 |
| `sceHttpSetRedirectCallback` | 0 |
| `sceHttpSetResolveRetry` | 0 |
| `sceHttpSetResolveTimeOut` | 0 |
| `sceHttpSetSendTimeOut` | 0 |
| `sceHttpsDisableOption` | 0 |
| `sceHttpsEnableOption` | 0 |
| `sceHttpsEnd` | 0 |
| `sceHttpsGetSslError` | 0 |
| `sceHttpsInit` | 1 |
| `sceHttpsInitWithPath` | 1 |
| `sceHttpsLoadDefaultCert` | 1 |
| `sceHttpsSetSslCallback` | 0 |

## `sceNet` / `sceNetApctl` / `sceNetUpnp`

Core networking init, the access-point control library (`sceNetApctl`) used to "connect" to an AP, the Ethernet-address helpers, and UPnP NAT helpers. All no-op stubs, so a game's connect attempts return success but never go anywhere.

| Function | Returns | Note |
| --- | --- | --- |
| `__NetApctlCallbacks` | 0 | Internal callback dispatch. |
| `sceNetInit` | 0 | |
| `sceNetTerm` | 0 | |
| `sceNetApctlAddHandler` | 1 | |
| `sceNetApctlAddInternalHandler` | 1 | |
| `sceNetApctlConnect` | 1 | |
| `sceNetApctlDelHandler` | 0 | |
| `sceNetApctlDelInternalHandler` | 0 | |
| `sceNetApctlDisconnect` | 1 | |
| `sceNetApctlGetBSSDescEntry` | 0 | |
| `sceNetApctlGetBSSDescEntry2` | 0 | |
| `sceNetApctlGetBSSDescEntryUser` | 0 | |
| `sceNetApctlGetBSSDescIDList` | 0 | |
| `sceNetApctlGetBSSDescIDList2` | 0 | |
| `sceNetApctlGetBSSDescIDListUser` | 0 | |
| `sceNetApctlGetInfo` | 0 | |
| `sceNetApctlGetState` | 0 | |
| `sceNetApctlInit` | 1 | |
| `sceNetApctlScan` | 0 | |
| `sceNetApctlScanSSID2` | 0 | |
| `sceNetApctlScanUser` | 0 | |
| `sceNetApctlTerm` | 0 | |
| `sceNetApctl_6F5D2981` | 0 | Unnamed Apctl export. |
| `sceNetApctl_A7BB73DF` | 0 | Unnamed Apctl export. |
| `sceNetApctl_lib2_4C19731F` | 0 | Unnamed Apctl (lib2) export. |
| `sceNetApctl_lib2_69745F0A` | 0 | Unnamed Apctl (lib2) export. |
| `sceNetApctl_lib2_C20A144C` | 0 | Unnamed Apctl (lib2) export. |
| `sceNetEtherNtostr` | 0 | |
| `sceNetEtherStrton` | 0 | |
| `sceNetFreeThreadinfo` | 0 | |
| `sceNetGetDropRate` | 0 | |
| `sceNetGetLocalEtherAddr` | 1 | |
| `sceNetGetLocalEtherAddrAlt` | 0 | |
| `sceNetGetMallocStat` | 1 | |
| `sceNetSetDropRate` | 0 | |
| `sceNetThreadAbort` | 0 | |
| `sceNetUpnpGetNatInfo` | 0 | |
| `sceNetUpnpInit` | 1 | |
| `sceNetUpnpStart` | 1 | |
| `sceNetUpnpStop` | 0 | |
| `sceNetUpnpTerm` | 0 | |
| `sceWlanDevIsPowerOn` | 0 | WLAN power query exported under sceNet. |

## `sceNetAdhoc` / `sceNetAdhocctl`

Ad-hoc (peer-to-peer Wi-Fi) networking: the PDP/PTP sockets, ad-hoc game mode, and the `sceNetAdhocctl` control layer that joins and scans ad-hoc groups. All no-op stubs, so local multiplayer never finds peers.

| Function | Returns | Note |
| --- | --- | --- |
| `__NetTriggerCallbacks` | 0 | Internal callback dispatch. |
| `sceNetAdhocInit` | 0 | |
| `sceNetAdhocTerm` | 0 | |
| `sceNetAdhocDiscoverGetStatus` | 0 | |
| `sceNetAdhocDiscoverInitStart` | 1 | |
| `sceNetAdhocDiscoverRequestSuspend` | 0 | |
| `sceNetAdhocDiscoverStop` | 0 | |
| `sceNetAdhocDiscoverTerm` | 0 | |
| `sceNetAdhocDiscoverUpdate` | 0 | |
| `sceNetAdhocGameModeCreateMaster` | 1 | |
| `sceNetAdhocGameModeCreateReplica` | 1 | |
| `sceNetAdhocGameModeDeleteMaster` | 0 | |
| `sceNetAdhocGameModeDeleteReplica` | 0 | |
| `sceNetAdhocGameModeUpdateMaster` | 0 | |
| `sceNetAdhocGameModeUpdateReplica` | 0 | |
| `sceNetAdhocGetPdpStat` | 0 | |
| `sceNetAdhocGetPtpStat` | 0 | |
| `sceNetAdhocGetSocketAlert` | 0 | |
| `sceNetAdhocPdpCreate` | 1 | |
| `sceNetAdhocPdpDelete` | 0 | |
| `sceNetAdhocPdpRecv` | 0 | |
| `sceNetAdhocPdpSend` | 0 | |
| `sceNetAdhocPollSocket` | 0 | |
| `sceNetAdhocPtpAccept` | 0 | |
| `sceNetAdhocPtpClose` | 0 | |
| `sceNetAdhocPtpConnect` | 1 | |
| `sceNetAdhocPtpFlush` | 0 | |
| `sceNetAdhocPtpListen` | 0 | |
| `sceNetAdhocPtpOpen` | 1 | |
| `sceNetAdhocPtpRecv` | 0 | |
| `sceNetAdhocPtpSend` | 0 | |
| `sceNetAdhocSetSocketAlert` | 0 | |
| `sceNetAdhocctlAddHandler` | 1 | |
| `sceNetAdhocctlConnect` | 1 | |
| `sceNetAdhocctlCreate` | 1 | |
| `sceNetAdhocctlCreateEnterGameMode` | 1 | |
| `sceNetAdhocctlCreateEnterGameModeMin` | 1 | |
| `sceNetAdhocctlDelHandler` | 0 | |
| `sceNetAdhocctlDisconnect` | 1 | |
| `sceNetAdhocctlExitGameMode` | 0 | |
| `sceNetAdhocctlGetAddrByName` | 1 | |
| `sceNetAdhocctlGetAdhocId` | 0 | |
| `sceNetAdhocctlGetGameModeInfo` | 0 | |
| `sceNetAdhocctlGetNameByAddr` | 1 | |
| `sceNetAdhocctlGetParameter` | 0 | |
| `sceNetAdhocctlGetPeerInfo` | 0 | |
| `sceNetAdhocctlGetPeerList` | 0 | |
| `sceNetAdhocctlGetScanInfo` | 0 | |
| `sceNetAdhocctlGetState` | 0 | |
| `sceNetAdhocctlInit` | 1 | |
| `sceNetAdhocctlJoin` | 0 | |
| `sceNetAdhocctlJoinEnterGameMode` | 0 | |
| `sceNetAdhocctlScan` | 0 | |
| `sceNetAdhocctlTerm` | 0 | |

## `sceNetAdhocMatching`

The ad-hoc matching layer that pairs hosts and clients before a session. All no-op stubs.

| Function | Returns | Note |
| --- | --- | --- |
| `__NetMatchingCallbacks` | 0 | Internal callback dispatch. |
| `sceNetAdhocMatchingAbortSendData` | 0 | |
| `sceNetAdhocMatchingCancelTarget` | 0 | |
| `sceNetAdhocMatchingCancelTargetWithOpt` | 0 | |
| `sceNetAdhocMatchingCreate` | 1 | |
| `sceNetAdhocMatchingDelete` | 0 | |
| `sceNetAdhocMatchingGetHelloOpt` | 0 | |
| `sceNetAdhocMatchingGetMembers` | 0 | |
| `sceNetAdhocMatchingGetPoolMaxAlloc` | 1 | |
| `sceNetAdhocMatchingGetPoolStat` | 0 | |
| `sceNetAdhocMatchingInit` | 1 | |
| `sceNetAdhocMatchingSelectTarget` | 0 | |
| `sceNetAdhocMatchingSendData` | 0 | |
| `sceNetAdhocMatchingSetHelloOpt` | 0 | |
| `sceNetAdhocMatchingStart` | 1 | |
| `sceNetAdhocMatchingStart2` | 1 | |
| `sceNetAdhocMatchingStop` | 0 | |
| `sceNetAdhocMatchingTerm` | 0 | |

## `sceNetInet`

The BSD-style socket layer (`socket`/`bind`/`connect`/`send`/`recv`/`select`, address conversion, socket options). All no-op stubs, so no socket ever opens.

| Function | Returns |
| --- | --- |
| `sceNetInetAccept` | 0 |
| `sceNetInetBind` | 0 |
| `sceNetInetClose` | 0 |
| `sceNetInetCloseWithRST` | 0 |
| `sceNetInetConnect` | 1 |
| `sceNetInetGetErrno` | 0 |
| `sceNetInetGetPspError` | 0 |
| `sceNetInetGetTcpcbstat` | 0 |
| `sceNetInetGetUdpcbstat` | 0 |
| `sceNetInetGetpeername` | 0 |
| `sceNetInetGetsockname` | 0 |
| `sceNetInetGetsockopt` | 0 |
| `sceNetInetInetAddr` | 1 |
| `sceNetInetInetAton` | 0 |
| `sceNetInetInetNtop` | 0 |
| `sceNetInetInetPton` | 0 |
| `sceNetInetListen` | 0 |
| `sceNetInetPoll` | 0 |
| `sceNetInetRecv` | 0 |
| `sceNetInetRecvfrom` | 0 |
| `sceNetInetRecvmsg` | 0 |
| `sceNetInetSelect` | 0 |
| `sceNetInetSend` | 0 |
| `sceNetInetSendmsg` | 0 |
| `sceNetInetSendto` | 0 |
| `sceNetInetSetsockopt` | 0 |
| `sceNetInetShutdown` | 0 |
| `sceNetInetSocket` | 0 |
| `sceNetInetSocketAbort` | 0 |
| `sceNetInetTerm` | 0 |

## `sceNet` string/util library

A small C-runtime-style helper library the network modules export (string and memory helpers, rand, sprintf). All no-op stubs, so callers get a 0 back instead of a real result.

| Function | Returns |
| --- | --- |
| `sceNetMemcmp` | 0 |
| `sceNetMemmove` | 0 |
| `sceNetRand` | 0 |
| `sceNetSprintf` | 0 |
| `sceNetStrcasecmp` | 0 |
| `sceNetStrchr` | 0 |
| `sceNetStrcmp` | 0 |
| `sceNetStrcpy` | 0 |
| `sceNetStrlen` | 0 |
| `sceNetStrncmp` | 0 |
| `sceNetStrncpy` | 0 |
| `sceNetStrtoul` | 0 |

## `sceNetResolver`

DNS resolution (name-to-address and address-to-name, sync and async). All no-op stubs, so no hostname ever resolves.

| Function | Returns |
| --- | --- |
| `sceNetResolverCreate` | 1 |
| `sceNetResolverDelete` | 0 |
| `sceNetResolverInit` | 1 |
| `sceNetResolverPollAsync` | 0 |
| `sceNetResolverStartAtoN` | 1 |
| `sceNetResolverStartAtoNAsync` | 1 |
| `sceNetResolverStartNtoA` | 1 |
| `sceNetResolverStartNtoAAsync` | 1 |
| `sceNetResolverStop` | 0 |
| `sceNetResolverTerm` | 0 |
| `sceNetResolverWaitAsync` | 0 |

## `sceNp`

PlayStation Network: auth tickets, the NP commerce store, account/profile lookups, friend roster, and title small-storage lookups. All no-op stubs, so sign-in and online services do nothing.

| Function | Returns |
| --- | --- |
| `sceNpAuthAbortRequest` | 0 |
| `sceNpAuthCreateStartRequest` | 1 |
| `sceNpAuthDestroyRequest` | 0 |
| `sceNpAuthGetEntitlementById` | 0 |
| `sceNpAuthGetEntitlementIdList` | 0 |
| `sceNpAuthGetMemoryStat` | 0 |
| `sceNpAuthGetTicket` | 0 |
| `sceNpAuthGetTicketParam` | 0 |
| `sceNpAuthInit` | 1 |
| `sceNpAuthTerm` | 0 |
| `sceNpCommerce2AbortReq` | 0 |
| `sceNpCommerce2CreateCtx` | 1 |
| `sceNpCommerce2CreateSessionCreateReq` | 1 |
| `sceNpCommerce2CreateSessionGetResult` | 1 |
| `sceNpCommerce2CreateSessionStart` | 1 |
| `sceNpCommerce2DestroyCtx` | 0 |
| `sceNpCommerce2DestroyReq` | 0 |
| `sceNpCommerce2GetGameProductInfo` | 0 |
| `sceNpCommerce2GetGameSkuInfoFromGameProductInfo` | 0 |
| `sceNpCommerce2GetProductInfoCreateReq` | 1 |
| `sceNpCommerce2GetProductInfoGetResult` | 0 |
| `sceNpCommerce2GetProductInfoStart` | 1 |
| `sceNpCommerce2GetSessionInfo` | 0 |
| `sceNpCommerce2Init` | 1 |
| `sceNpCommerce2InitGetProductInfoResult` | 1 |
| `sceNpCommerce2Term` | 0 |
| `sceNpGetAccountRegion` | 0 |
| `sceNpGetChatRestrictionFlag` | 0 |
| `sceNpGetContentRatingFlag` | 0 |
| `sceNpGetMyLanguages` | 0 |
| `sceNpGetNpId` | 0 |
| `sceNpGetOnlineId` | 0 |
| `sceNpGetUserProfile` | 0 |
| `sceNpInit` | 0 |
| `sceNpLookupAbortTransaction` | 0 |
| `sceNpLookupCreateTransactionCtx` | 1 |
| `sceNpLookupDestroyTransactionCtx` | 0 |
| `sceNpLookupTitleSmallStorage` | 0 |
| `sceNpRosterAbort` | 0 |
| `sceNpRosterAddFriendListEntry` | 1 |
| `sceNpRosterCreateRequest` | 1 |
| `sceNpRosterDeleteRequest` | 0 |
| `sceNpRosterGetBlockListEntry` | 0 |
| `sceNpRosterGetBlockListEntryCount` | 0 |
| `sceNpRosterGetFriendListEntry` | 0 |
| `sceNpRosterGetFriendListEntryCount` | 0 |
| `sceNpServiceGetMemoryStat` | 0 |
| `sceNpServiceInit` | 1 |
| `sceNpServiceTerm` | 0 |
| `sceNpTerm` | 0 |

## `sceNpMatching2`

PSN room-based matchmaking (create/join/search rooms, room data, signaling). All no-op stubs.

| Function | Returns |
| --- | --- |
| `sceNpMatching2AbortRequest` | 0 |
| `sceNpMatching2ContextStart` | 1 |
| `sceNpMatching2ContextStop` | 0 |
| `sceNpMatching2CreateContext` | 1 |
| `sceNpMatching2CreateJoinRoom` | 1 |
| `sceNpMatching2DestroyContext` | 0 |
| `sceNpMatching2GetMemoryStat` | 0 |
| `sceNpMatching2GetRoomDataExternalList` | 0 |
| `sceNpMatching2GetServerIdListLocal` | 0 |
| `sceNpMatching2GetServerInfo` | 0 |
| `sceNpMatching2GetWorldInfoList` | 0 |
| `sceNpMatching2Init` | 1 |
| `sceNpMatching2JoinRoom` | 0 |
| `sceNpMatching2KickoutRoomMember` | 0 |
| `sceNpMatching2LeaveRoom` | 0 |
| `sceNpMatching2RegisterSignalingCallback` | 1 |
| `sceNpMatching2SearchRoom` | 0 |
| `sceNpMatching2SendRoomChatMessage` | 0 |
| `sceNpMatching2SetRoomDataInternal` | 0 |
| `sceNpMatching2SignalingGetConnectionStatus` | 1 |
| `sceNpMatching2Term` | 0 |

## `sceWlan`

Wi-Fi hardware queries. All no-op stubs.

| Function | Returns |
| --- | --- |
| `sceWlanGetEtherAddr` | 0 |
| `sceWlanGetSwitchState` | 0 |

## `sceOpenPSID`

Console identity (the per-unit OpenPSID/PSID and product code). All no-op stubs, so games read a zeroed identity.

| Function | Returns | Note |
| --- | --- | --- |
| `sceDdrdb_F013F8BF` | 0 | Unnamed export grouped with OpenPSID. |
| `sceOpenPSIDGetOpenPSID` | 1 | |
| `sceOpenPSIDGetPSID` | 1 | |
| `sceOpenPSIDGetProductCode` | 1 | |

## `sceSsl`

TLS/SSL certificate inspection and memory accounting. All no-op stubs.

| Function | Returns |
| --- | --- |
| `sceSslEnd` | 0 |
| `sceSslGetIssuerName` | 0 |
| `sceSslGetKeyUsage` | 0 |
| `sceSslGetNameEntryCount` | 0 |
| `sceSslGetNameEntryInfo` | 0 |
| `sceSslGetNotAfter` | 0 |
| `sceSslGetNotBefore` | 0 |
| `sceSslGetSerialNumber` | 0 |
| `sceSslGetSubjectName` | 0 |
| `sceSslGetUsedMemoryCurrent` | 0 |
| `sceSslGetUsedMemoryMax` | 0 |
| `sceSslInit` | 1 |

## `sceParseHttpHeader`

HTTP response/status-line parsing. All no-op stubs.

| Function | Returns |
| --- | --- |
| `sceParseHttpResponseHeader` | 0 |
| `sceParseHttpStatusLine` | 0 |

## `sceParseUri`

URI building, parsing, and escape/unescape. All no-op stubs.

| Function | Returns |
| --- | --- |
| `sceUriBuild` | 1 |
| `sceUriEscape` | 0 |
| `sceUriParse` | 0 |
| `sceUriUnescape` | 0 |

## `scePauth`

Package authentication helpers (only the unnamed exports are known by NID). All no-op stubs.

| Function | Returns | Note |
| --- | --- | --- |
| `scePauth_98B83B5D` | 0 | Unnamed Pauth export. |
| `scePauth_F7AA47F6` | 0 | Unnamed Pauth export. |
