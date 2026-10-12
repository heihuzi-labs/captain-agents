# 给 Codex 的离线专用账户补上“本机回环”的拦截。依据：docs/research/windows-codex-sandbox-2026-10-12.md。
# Codex 靠 Windows 防火墙规则拦本机回环，实测拦不住（防火墙不过滤发往本机的连接）。
# 这里直接往系统的过滤平台（WFP）加 6 条只对这一个账户生效的规则：
#   连出：目的地是本机回环的，拦（IPv4、IPv6）
#   开监听口：拦（IPv4、IPv6）
#   收进来：来自本机回环的，拦（IPv4、IPv6）
# 规则是持久的（重启后还在），标识固定，重复安装不会叠加；-Action remove 全部撤掉。要管理员权限。
# 只动这一个专用账户：主人自己的账户、允许联网时用的另一个专用账户都不受影响。
# 有没有生效以隔离自检里的本机端口探针为准，不以“装过”为准。
param(
  [ValidateSet('install', 'remove')] [string]$Action = 'install',
  [string]$Account = 'CodexSandboxOffline'
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public static class XaLoopbackFence {
  [StructLayout(LayoutKind.Sequential)] struct DisplayData { public IntPtr name; public IntPtr description; }
  [StructLayout(LayoutKind.Sequential)] struct Blob { public uint size; public IntPtr data; }
  [StructLayout(LayoutKind.Sequential)] struct Value { public uint type; public ulong value; }
  [StructLayout(LayoutKind.Sequential)] struct Provider { public Guid providerKey; public DisplayData displayData; public uint flags; public Blob providerData; public IntPtr serviceName; }
  [StructLayout(LayoutKind.Sequential)] struct SubLayer { public Guid subLayerKey; public DisplayData displayData; public uint flags; public IntPtr providerKey; public Blob providerData; public ushort weight; }
  [StructLayout(LayoutKind.Sequential)] struct Condition { public Guid fieldKey; public uint matchType; public Value conditionValue; }
  [StructLayout(LayoutKind.Sequential)] struct FilterAction { public uint type; public Guid filterType; }
  [StructLayout(LayoutKind.Sequential)] struct Filter {
    public Guid filterKey; public DisplayData displayData; public uint flags; public IntPtr providerKey; public Blob providerData;
    public Guid layerKey; public Guid subLayerKey; public Value weight; public uint numFilterConditions; public IntPtr filterCondition;
    public FilterAction action; public ulong rawContext; public ulong rawContextRest; public IntPtr reserved; public ulong filterId; public Value effectiveWeight;
  }

  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr serverName, uint authnService, IntPtr authIdentity, IntPtr session, out IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderAdd0(IntPtr engine, ref Provider provider, IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine, ref SubLayer subLayer, IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr sd, out ulong id);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine, ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderDeleteByKey0(IntPtr engine, ref Guid key);

  const uint RPC_C_AUTHN_WINNT = 10, PERSISTENT = 1, FWP_ACTION_BLOCK = 0x1001;
  const uint FWP_EMPTY = 0, FWP_UINT32 = 3, FWP_SECURITY_DESCRIPTOR_TYPE = 14;
  const uint FWP_MATCH_EQUAL = 0, FWP_MATCH_FLAGS_ALL_SET = 6, FWP_CONDITION_FLAG_IS_LOOPBACK = 1;
  const uint FWP_E_FILTER_NOT_FOUND = 0x80320003, FWP_E_PROVIDER_NOT_FOUND = 0x80320005, FWP_E_SUBLAYER_NOT_FOUND = 0x80320007, FWP_E_ALREADY_EXISTS = 0x80320009;

  static readonly Guid ProviderKey = new Guid("8dcaecb1-0f87-4dc7-8fd1-9b0fa03fbf4e");
  static readonly Guid SubLayerKey = new Guid("e44408ee-0a21-4d8f-930e-cb257fef4700");
  static readonly Guid ConditionUser = new Guid("af043a0a-b34d-4f86-979c-c90371af6e66");   // FWPM_CONDITION_ALE_USER_ID
  static readonly Guid ConditionFlags = new Guid("632ce23b-5167-435c-86d7-e903684aa80c");  // FWPM_CONDITION_FLAGS

  // 规则标识、名字、所在的层、是否只管本机回环。
  static readonly object[][] Specs = new object[][] {
    new object[] { "eb61be92-033b-4fb6-a500-bdbe67c0723b", "xagents_loopback_connect_v4", "c38d57d1-05a7-4c33-904f-7fbceee60e82", true },   // ALE_AUTH_CONNECT_V4
    new object[] { "4028069b-3c74-45ed-b180-de43900754b2", "xagents_loopback_connect_v6", "4a72393b-319f-44bc-84c3-ba54dcb3b6b4", true },   // ALE_AUTH_CONNECT_V6
    new object[] { "356494dc-0c2d-45da-9736-e294542aeb3d", "xagents_listen_v4", "88bb5dad-76d7-4227-9c71-df0a3ed7be7e", false },            // ALE_AUTH_LISTEN_V4
    new object[] { "bc91a0ff-d810-46c4-805a-c48c731d92b3", "xagents_listen_v6", "7ac9de24-17dd-4814-b4bd-a9fbc95a321b", false },            // ALE_AUTH_LISTEN_V6
    new object[] { "b880b4ed-54cd-40a6-a7f9-3215a6be3429", "xagents_loopback_accept_v4", "e1cd9fe7-f4b5-4273-96c0-592e487b8650", true },    // ALE_AUTH_RECV_ACCEPT_V4
    new object[] { "5fdb3d6d-b10e-425e-ae80-4bc899371fc4", "xagents_loopback_accept_v6", "a3b42c97-9f04-4672-b87e-cee9c483257f", true },    // ALE_AUTH_RECV_ACCEPT_V6
  };

  static void Check(uint result, string what, params uint[] tolerated) {
    if (result == 0) return;
    foreach (uint ok in tolerated) if (result == ok) return;
    throw new InvalidOperationException(what + " failed: 0x" + result.ToString("x8"));
  }

  static IntPtr Open() {
    IntPtr engine;
    Check(FwpmEngineOpen0(IntPtr.Zero, RPC_C_AUTHN_WINNT, IntPtr.Zero, IntPtr.Zero, out engine), "FwpmEngineOpen0");
    return engine;
  }

  static void DeleteFilters(IntPtr engine) {
    foreach (object[] spec in Specs) {
      Guid key = new Guid((string)spec[0]);
      Check(FwpmFilterDeleteByKey0(engine, ref key), "FwpmFilterDeleteByKey0(" + spec[1] + ")", FWP_E_FILTER_NOT_FOUND);
    }
  }

  public static string Remove() {
    IntPtr engine = Open();
    try {
      Check(FwpmTransactionBegin0(engine, 0), "FwpmTransactionBegin0");
      try {
        DeleteFilters(engine);
        Guid sub = SubLayerKey, provider = ProviderKey;
        Check(FwpmSubLayerDeleteByKey0(engine, ref sub), "FwpmSubLayerDeleteByKey0", FWP_E_SUBLAYER_NOT_FOUND);
        Check(FwpmProviderDeleteByKey0(engine, ref provider), "FwpmProviderDeleteByKey0", FWP_E_PROVIDER_NOT_FOUND);
        Check(FwpmTransactionCommit0(engine), "FwpmTransactionCommit0");
      } catch { FwpmTransactionAbort0(engine); throw; }
    } finally { FwpmEngineClose0(engine); }
    return "removed";
  }

  public static string Install(string sid) {
    // 只匹配这个账户：一份只给它“匹配规则”权限的安全描述符（和 Windows 防火墙按用户写规则是同一种写法）。
    RawSecurityDescriptor descriptor = new RawSecurityDescriptor("O:LSG:LSD:(A;;CC;;;" + new SecurityIdentifier(sid).Value + ")");
    byte[] sd = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(sd, 0);
    IntPtr name = Marshal.StringToHGlobalUni("xagents loopback fence");
    IntPtr description = Marshal.StringToHGlobalUni("Blocks loopback traffic for the Codex offline sandbox account");
    IntPtr sdData = Marshal.AllocHGlobal(sd.Length);
    IntPtr sdBlob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Blob)));
    IntPtr providerKey = Marshal.AllocHGlobal(16);
    IntPtr conditions = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Condition)) * 2);
    IntPtr engine = Open();
    int added = 0;
    try {
      Marshal.Copy(sd, 0, sdData, sd.Length);
      Blob blob = new Blob(); blob.size = (uint)sd.Length; blob.data = sdData;
      Marshal.StructureToPtr(blob, sdBlob, false);
      Marshal.Copy(ProviderKey.ToByteArray(), 0, providerKey, 16);
      Condition user = new Condition(); user.fieldKey = ConditionUser; user.matchType = FWP_MATCH_EQUAL;
      user.conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE; user.conditionValue.value = (ulong)sdBlob.ToInt64();
      Condition loopback = new Condition(); loopback.fieldKey = ConditionFlags; loopback.matchType = FWP_MATCH_FLAGS_ALL_SET;
      loopback.conditionValue.type = FWP_UINT32; loopback.conditionValue.value = FWP_CONDITION_FLAG_IS_LOOPBACK;
      Marshal.StructureToPtr(user, conditions, false);
      Marshal.StructureToPtr(loopback, new IntPtr(conditions.ToInt64() + Marshal.SizeOf(typeof(Condition))), false);

      Check(FwpmTransactionBegin0(engine, 0), "FwpmTransactionBegin0");
      try {
        Provider provider = new Provider(); provider.providerKey = ProviderKey; provider.displayData.name = name; provider.displayData.description = description; provider.flags = PERSISTENT;
        Check(FwpmProviderAdd0(engine, ref provider, IntPtr.Zero), "FwpmProviderAdd0", FWP_E_ALREADY_EXISTS);
        SubLayer sub = new SubLayer(); sub.subLayerKey = SubLayerKey; sub.displayData.name = name; sub.displayData.description = description; sub.flags = PERSISTENT; sub.providerKey = providerKey; sub.weight = 0x8000;
        Check(FwpmSubLayerAdd0(engine, ref sub, IntPtr.Zero), "FwpmSubLayerAdd0", FWP_E_ALREADY_EXISTS);
        DeleteFilters(engine);
        foreach (object[] spec in Specs) {
          IntPtr filterName = Marshal.StringToHGlobalUni((string)spec[1]);
          try {
            Filter filter = new Filter();
            filter.filterKey = new Guid((string)spec[0]); filter.displayData.name = filterName; filter.displayData.description = description;
            filter.flags = PERSISTENT; filter.providerKey = providerKey; filter.layerKey = new Guid((string)spec[2]); filter.subLayerKey = SubLayerKey;
            filter.weight.type = FWP_EMPTY; filter.numFilterConditions = (bool)spec[3] ? 2u : 1u; filter.filterCondition = conditions;
            filter.action.type = FWP_ACTION_BLOCK;
            ulong id;
            Check(FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out id), "FwpmFilterAdd0(" + spec[1] + ")");
            added++;
          } finally { Marshal.FreeHGlobal(filterName); }
        }
        Check(FwpmTransactionCommit0(engine), "FwpmTransactionCommit0");
      } catch { FwpmTransactionAbort0(engine); throw; }
    } finally {
      FwpmEngineClose0(engine);
      Marshal.FreeHGlobal(conditions); Marshal.FreeHGlobal(providerKey); Marshal.FreeHGlobal(sdBlob); Marshal.FreeHGlobal(sdData);
      Marshal.FreeHGlobal(description); Marshal.FreeHGlobal(name);
    }
    return "installed " + added + " filters for " + sid;
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
if ($Action -eq 'remove') { [XaLoopbackFence]::Remove(); exit 0 }
$sid = (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
[XaLoopbackFence]::Install($sid)
