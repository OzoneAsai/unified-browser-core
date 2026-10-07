using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

record Request(string Command, string? Credential, string? Salt, string? User, long Window);
record Response(bool Ok, string? Error = null, string? Credential = null, string? Secret = null, uint Api = 0);
[JsonSerializable(typeof(Request))][JsonSerializable(typeof(Response))]
partial class WireJson : JsonSerializerContext { }
static class Program {
    const string Rp = "ubc-passwords.localhost";
    static int Main() {
        try {
            var line=Console.ReadLine(); if(line is null || line.Length>16384) throw new Exception("invalid-request");
            var request=JsonSerializer.Deserialize(line,WireJson.Default.Request) ?? throw new Exception("invalid-request");
            var response=Run(request); Console.WriteLine(JsonSerializer.Serialize(response,WireJson.Default.Response)); return response.Ok?0:1;
        } catch(Exception e) { Console.WriteLine(JsonSerializer.Serialize(new Response(false,e.Message),WireJson.Default.Response)); return 1; }
    }
    static Response Run(Request r) {
        uint api=N.ApiVersion();
        if(r.Command=="capabilities") { Check(Available(out int available)); return new(available!=0,available==0?"hello-unavailable":null,Api:api); }
        if(api<8) throw new Exception("unsupported-api");
        using var a=new Arena();
        var hwnd=new IntPtr(r.Window); if(hwnd==IntPtr.Zero) hwnd=GetForegroundWindow();
        if(r.Command=="delete") { var id=Decode(r.Credential,1024); Check(N.Delete((uint)id.Length,a.Bytes(id))); return new(true); }
        var salt=Decode(r.Salt,32); if(salt.Length!=32) throw new Exception("invalid-salt");
        if(r.Command=="create") {
            var rp=new N.Rp {Version=1,Id=a.Wide(Rp),Name=a.Wide("Unified Browser Core password vault")};
            var uid=Decode(r.User,32); if(uid.Length!=32) throw new Exception("invalid-user");
            var user=new N.User {Version=1,Length=32,Id=a.Bytes(uid),Name=a.Wide("UBC password vault"),Display=a.Wide("Unified Browser Core")};
            var algorithms=new[]{new N.Algorithm{Version=1,Type=a.Wide("public-key"),Alg=-7},new N.Algorithm{Version=1,Type=a.Wide("public-key"),Alg=-257}};
            var algs=new N.List{Count=2,Values=a.Array(algorithms)}; var client=Client(a,"webauthn.create");
            var options=new N.MakeOptions{Version=8,Timeout=60000,Attachment=1,Resident=1,UV=1,Attestation=1,EnablePrf=1,Eval=a.Struct(Salt(a,salt))};
            Check(N.Make(hwnd,ref rp,ref user,ref algs,ref client,ref options,out var output));
            byte[]? id=null;
            try {
                var result=Marshal.PtrToStructure<N.Attestation>(output); id=Copy(result.Id,result.IdLength); Validate(Copy(result.Auth,result.AuthLength));
                if(result.Version<7 || result.Prf==0 || result.Secret==IntPtr.Zero) throw new Exception("prf-unavailable");
                var secret=Secret(result.Secret);
                try{return new(true,Credential:Convert.ToBase64String(id),Secret:Convert.ToBase64String(secret));}
                finally{CryptographicOperations.ZeroMemory(secret);}
            } catch { if(id is not null) N.Delete((uint)id.Length,a.Bytes(id)); throw; }
            finally{N.FreeAttestation(output);}
        }
        if(r.Command!="unlock") throw new Exception("unknown-command");
        var credential=Decode(r.Credential,1024); var cred=new N.Credential{Version=1,Length=(uint)credential.Length,Id=a.Bytes(credential),Type=a.Wide("public-key")};
        var get=new N.GetOptions{Version=6,Timeout=60000,Credentials=new N.List{Count=1,Values=a.Struct(cred)},Attachment=1,UV=1,SaltValues=a.Struct(new N.SaltValues{Global=a.Struct(Salt(a,salt))})};
        var data=Client(a,"webauthn.get"); Check(N.Get(hwnd,Rp,ref data,ref get,out var assertion));
        try {
            var result=Marshal.PtrToStructure<N.Assertion>(assertion); Validate(Copy(result.Auth,result.AuthLength));
            if(!CryptographicOperations.FixedTimeEquals(Copy(result.Credential.Id,result.Credential.Length),credential)) throw new Exception("credential-mismatch");
            if(result.Version<3 || result.Secret==IntPtr.Zero) throw new Exception("prf-unavailable");
            var secret=Secret(result.Secret);try{return new(true,Secret:Convert.ToBase64String(secret));}finally{CryptographicOperations.ZeroMemory(secret);}
        } finally{N.FreeAssertion(assertion);}
    }
    static byte[] Decode(string? value,int max){var b=Convert.FromBase64String(value??"");if(b.Length==0||b.Length>max)throw new Exception("invalid-buffer");return b;}
    static N.Salt Salt(Arena a,byte[] b)=>new(){FirstLength=(uint)b.Length,First=a.Bytes(b)};
    static N.Client Client(Arena a,string type){
        var challenge=Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_');
        var bytes=Encoding.UTF8.GetBytes("{\"type\":\""+type+"\",\"challenge\":\""+challenge+"\",\"origin\":\"https://"+Rp+"\",\"crossOrigin\":false}");
        return new(){Version=1,Length=(uint)bytes.Length,Json=a.Bytes(bytes),Hash=a.Wide("SHA-256")};
    }
    static void Validate(byte[] auth){if(auth.Length<37||(auth[32]&5)!=5||!CryptographicOperations.FixedTimeEquals(auth.AsSpan(0,32),SHA256.HashData(Encoding.UTF8.GetBytes(Rp))))throw new Exception("verification-failed");}
    static byte[] Secret(IntPtr p){var s=Marshal.PtrToStructure<N.Salt>(p);if(s.FirstLength!=32)throw new Exception("invalid-prf");return Copy(s.First,s.FirstLength);}
    static byte[] Copy(IntPtr p,uint size){if(size>1048576||(size!=0&&p==IntPtr.Zero))throw new Exception("invalid-buffer");var b=new byte[(int)size];if(size!=0)Marshal.Copy(p,b,0,b.Length);return b;}
    static void Check(int hr){if(hr<0)throw new Exception($"0x{hr:X8}:{Marshal.PtrToStringUni(N.ErrorName(hr))}");}
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("webauthn.dll",EntryPoint="WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable")]static extern int Available(out int available);
}
