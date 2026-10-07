using System.Runtime.InteropServices;
using System.Text;
sealed class Arena : IDisposable {
    readonly List<(IntPtr,int)> allocated=[];
    public IntPtr Bytes(byte[] bytes) { var p=Marshal.AllocHGlobal(Math.Max(1,bytes.Length)); allocated.Add((p,Math.Max(1,bytes.Length))); Marshal.Copy(bytes,0,p,bytes.Length); return p; }
    public IntPtr Wide(string s) => Bytes(Encoding.Unicode.GetBytes(s+"\0"));
    public IntPtr Struct<T>(T s) where T:struct { var n=Marshal.SizeOf<T>(); var p=Bytes(new byte[n]); Marshal.StructureToPtr(s,p,false); return p; }
    public IntPtr Array<T>(T[] values) where T:struct { var n=Marshal.SizeOf<T>(); var p=Bytes(new byte[n*values.Length]); for(int i=0;i<values.Length;i++) Marshal.StructureToPtr(values[i],p+i*n,false); return p; }
    public void Dispose() { foreach(var (p,n) in allocated) { Marshal.Copy(new byte[n],0,p,n); Marshal.FreeHGlobal(p); } }
}

static class N {
    // Layouts follow Microsoft's webauthn.h; Windows BOOL represented by Int32.
    [StructLayout(LayoutKind.Sequential)] public struct List { public uint Count; public IntPtr Values; }
    [StructLayout(LayoutKind.Sequential)] public struct Rp { public uint Version; public IntPtr Id,Name,Icon; }
    [StructLayout(LayoutKind.Sequential)] public struct User { public uint Version,Length; public IntPtr Id,Name,Icon,Display; }
    [StructLayout(LayoutKind.Sequential)] public struct Algorithm { public uint Version; public IntPtr Type; public int Alg; }
    [StructLayout(LayoutKind.Sequential)] public struct Client { public uint Version,Length; public IntPtr Json,Hash; }
    [StructLayout(LayoutKind.Sequential)] public struct Credential { public uint Version,Length; public IntPtr Id,Type; }
    [StructLayout(LayoutKind.Sequential)] public struct Salt { public uint FirstLength; public IntPtr First; public uint SecondLength; public IntPtr Second; }
    [StructLayout(LayoutKind.Sequential)] public struct SaltValues { public IntPtr Global; public uint Count; public IntPtr Values; }
    [StructLayout(LayoutKind.Sequential)] public struct MakeOptions {
        public uint Version,Timeout; public List Credentials,Extensions; public uint Attachment; public int Resident; public uint UV,Attestation,Flags;
        public IntPtr Cancel,Exclude; public uint Enterprise,LargeBlob; public int PreferResident,Private,EnablePrf; public IntPtr Linked;
        public uint JsonLength; public IntPtr Json,Eval; public uint HintCount; public IntPtr Hints; public int ThirdParty;
    }
    [StructLayout(LayoutKind.Sequential)] public struct GetOptions {
        public uint Version,Timeout; public List Credentials,Extensions; public uint Attachment,UV,Flags; public IntPtr AppId,UsedAppId,Cancel,Allow;
        public uint BlobOperation,BlobLength; public IntPtr Blob,SaltValues; public int Private;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Attestation {
        public uint Version; public IntPtr Format; public uint AuthLength; public IntPtr Auth; public uint AttestationLength; public IntPtr AttestationData;
        public uint DecodeType; public IntPtr Decode; public uint ObjectLength; public IntPtr Object; public uint IdLength; public IntPtr Id;
        public List Extensions; public uint Transport; public int Enterprise,LargeBlob,Resident,Prf; public uint UnsignedLength; public IntPtr Unsigned,Secret; public int ThirdParty;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Assertion {
        public uint Version,AuthLength; public IntPtr Auth; public uint SignatureLength; public IntPtr Signature; public Credential Credential;
        public uint UserLength; public IntPtr User; public List Extensions; public uint BlobLength; public IntPtr Blob; public uint BlobStatus; public IntPtr Secret;
    }
    [DllImport("webauthn.dll",EntryPoint="WebAuthNGetApiVersionNumber")] public static extern uint ApiVersion();
    [DllImport("webauthn.dll",EntryPoint="WebAuthNAuthenticatorMakeCredential")] public static extern int Make(IntPtr hwnd,ref Rp rp,ref User user,ref List algs,ref Client client,ref MakeOptions options,out IntPtr output);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNAuthenticatorGetAssertion",CharSet=CharSet.Unicode)] public static extern int Get(IntPtr hwnd,string rp,ref Client client,ref GetOptions options,out IntPtr output);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNFreeCredentialAttestation")] public static extern void FreeAttestation(IntPtr output);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNFreeAssertion")] public static extern void FreeAssertion(IntPtr output);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNGetErrorName")] public static extern IntPtr ErrorName(int hr);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNGetCancellationId")] public static extern int CancellationId(out Guid id);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNCancelCurrentOperation")] public static extern int Cancel(ref Guid id);
    [DllImport("webauthn.dll",EntryPoint="WebAuthNDeletePlatformCredential")] public static extern int Delete(uint length,IntPtr id);
}

