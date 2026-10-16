#include <v8.h>
#include <libplatform/libplatform.h>
#include <iostream>
#include <memory>
#include <string>
#include <cstdlib>
#include <fstream>
#include <vector>
#include <iterator>

struct NativeDocument {
  int stable_id;
  int version;
  int event_listener_count;
  int origin_id;
  std::vector<v8::Global<v8::Function>> callbacks;
};
static NativeDocument old_document{1,12,3,7};
static NativeDocument old_element{2,7,1,7};
static NativeDocument fresh_document{1,99,0,7};
static NativeDocument fresh_element{2,66,0,7};
static bool rejected_other_origin=false;
// The map is constructed anew by the destination process. No native pointer
// address is serialized: stable resource IDs identify the recreated objects.
struct FreshGraph { NativeDocument* nodes[3]; };
static FreshGraph fresh_graph{{nullptr,&fresh_document,&fresh_element}};
static int serialization_calls=0;
static int rebinding_calls=0;
static void NativeRead(const v8::FunctionCallbackInfo<v8::Value>& args) {
  void* native = args.This()->GetAlignedPointerFromInternalField(0);
  if (!native) { args.GetReturnValue().Set(-1); return; }
  auto* document = static_cast<NativeDocument*>(native);
  // A real DOM EventTarget keeps native listener registrations outside V8.
  args.GetReturnValue().Set(args.Length() ? document->event_listener_count : document->version);
}
static void RegisterSyntheticListener(const v8::FunctionCallbackInfo<v8::Value>& args) {
  if (args.Length() != 1 || !args[0]->IsFunction()) return;
  void* native = args.This()->GetAlignedPointerFromInternalField(0);
  if (!native) return;
  auto* target = static_cast<NativeDocument*>(native);
  target->event_listener_count++;
  target->callbacks.emplace_back(args.GetIsolate(),args[0].As<v8::Function>());
}
static void DispatchSyntheticEvent(const v8::FunctionCallbackInfo<v8::Value>& args) {
  void* native = args.This()->GetAlignedPointerFromInternalField(0);
  if (!native) return;
  auto* target = static_cast<NativeDocument*>(native);
  auto* isolate = args.GetIsolate();
  auto context=isolate->GetCurrentContext();
  int delivered=0;
  for (auto& callback : target->callbacks) {
    v8::Local<v8::Value> ignored;
    if (callback.Get(isolate)->Call(context,args.This(),0,nullptr).ToLocal(&ignored))
      ++delivered;
  }
  args.GetReturnValue().Set(delivered);
}
static v8::StartupData SaveWrapper(v8::Local<v8::Object> object,int field,void*) {
  if (field != 0) return {nullptr,0};
  ++serialization_calls;
  auto* source = static_cast<NativeDocument*>(object->GetAlignedPointerFromInternalField(field));
  if (!source || source->stable_id < 1 || source->stable_id > 2) std::abort();
  return {new char[4]{'D',static_cast<char>(source->stable_id),
                      'O',static_cast<char>(source->origin_id)},4};
}
static void RestoreWrapper(v8::Local<v8::Object> object,int field,v8::StartupData data,void* fresh) {
  if (field != 0 || data.raw_size != 4 || data.data[0]!='D' || data.data[2]!='O') std::abort();
  const int id = static_cast<unsigned char>(data.data[1]);
  auto* graph = static_cast<FreshGraph*>(fresh);
  if (id < 1 || id > 2 || !graph->nodes[id] || graph->nodes[id]->stable_id != id) std::abort();
  if (graph->nodes[id]->origin_id != static_cast<unsigned char>(data.data[3])) {
    rejected_other_origin=true;
    object->SetAlignedPointerInInternalField(field,nullptr);
    return;
  }
  ++rebinding_calls;
  object->SetAlignedPointerInInternalField(field,graph->nodes[id]);
}
static v8::Local<v8::String> Str(v8::Isolate* v,const char* s) {
  return v8::String::NewFromUtf8(v,s).ToLocalChecked();
}
static std::string Eval(v8::Isolate* v,v8::Local<v8::Context> ctx,const char* script) {
  auto source=Str(v,script);
  v8::Local<v8::Script> compiled;
  if (!v8::Script::Compile(ctx,source).ToLocal(&compiled)) return "compile-error";
  v8::Local<v8::Value> result;
  if (!compiled->Run(ctx).ToLocal(&result)) return "runtime-error";
  v8::String::Utf8Value utf8(v,result);
  return *utf8?*utf8:"empty";
}
int main(int argc,char** argv) {
  v8::V8::InitializeICUDefaultLocation(argv[0]);
  v8::V8::InitializeExternalStartupData(argv[0]);
  auto platform=v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();
  std::unique_ptr<v8::ArrayBuffer::Allocator> allocator(v8::ArrayBuffer::Allocator::NewDefaultAllocator());
  const intptr_t references[]={reinterpret_cast<intptr_t>(NativeRead),
                                reinterpret_cast<intptr_t>(RegisterSyntheticListener),
                                reinterpret_cast<intptr_t>(DispatchSyntheticEvent),0};
  v8::StartupData blob{};
  const bool wrong_origin = argc >= 3 && std::string(argv[1]) == "load-wrong-origin";
  const bool loading = argc >= 3 && (std::string(argv[1]) == "load" || wrong_origin);
  if (wrong_origin) fresh_document.origin_id = 19;
  const bool building = argc >= 3 && std::string(argv[1]) == "build";
  std::vector<char> loaded_bytes;
  if (loading) {
    std::ifstream file(argv[2],std::ios::binary);
    loaded_bytes.assign(std::istreambuf_iterator<char>(file),{});
    if(loaded_bytes.empty()) return 8;
    blob={loaded_bytes.data(),static_cast<int>(loaded_bytes.size())};
    std::cout << "LOADED_FILE_BYTES=" << blob.raw_size << "\n";
  }
  if (!loading) {
    v8::Isolate::CreateParams params;
    params.array_buffer_allocator=allocator.get();
    params.external_references=references;
    v8::SnapshotCreator creator(params);
    auto* isolate=creator.GetIsolate();
    {
      v8::HandleScope scope(isolate);
      creator.SetDefaultContext(v8::Context::New(isolate));
      auto context=v8::Context::New(isolate);
      v8::Context::Scope cs(context);
      auto temp=v8::ObjectTemplate::New(isolate);
      temp->SetInternalFieldCount(1);
      temp->Set(Str(isolate,"read"),v8::FunctionTemplate::New(isolate,NativeRead));
      temp->Set(Str(isolate,"registerSyntheticListener"),
                v8::FunctionTemplate::New(isolate,RegisterSyntheticListener));
      temp->Set(Str(isolate,"dispatchSyntheticEvent"),
                v8::FunctionTemplate::New(isolate,DispatchSyntheticEvent));
      auto doc=temp->NewInstance(context).ToLocalChecked();
      doc->SetAlignedPointerInInternalField(0,&old_document);
      context->Global()->Set(context,Str(isolate,"document"),doc).Check();
      auto element=temp->NewInstance(context).ToLocalChecked();
      element->SetAlignedPointerInInternalField(0,&old_element);
      context->Global()->Set(context,Str(isolate,"element"),element).Check();
      const auto init=Eval(isolate,context,R"(
        globalThis.syntheticState=(()=>{
          let hidden=40;
          const documentWrapper=document;
          const elementWrapper=element;
          const handler=()=>++hidden;
          globalThis.syntheticRegistrations=[
            {target:documentWrapper,type:'click',callback:handler},
            {target:documentWrapper,type:'focus',callback:handler},
            {target:documentWrapper,type:'input',callback:handler},
            {target:elementWrapper,type:'mouseover',callback:handler},
          ];
          globalThis.rebindSyntheticListeners=()=>{
            for(const entry of syntheticRegistrations)
              entry.target.registerSyntheticListener(entry.callback);
            return syntheticRegistrations.length;
          };
          return ()=>JSON.stringify({counter:++hidden,
            nativeDocumentVersion:documentWrapper.read(),
            nativeElementVersion:elementWrapper.read(),
            nativeEventListenerCount:documentWrapper.read(true),
            documentReferenceStillSame:documentWrapper===document,
            elementReferenceStillSame:elementWrapper===element});
        })();
        'ready'
      )");
      if (init!="ready") return 4;
      creator.AddContext(context,v8::SerializeInternalFieldsCallback(SaveWrapper));
    }
    blob=creator.CreateBlob(v8::SnapshotCreator::FunctionCodeHandling::kClear);
  }
  if(!blob.data || blob.raw_size<=0) return 5;
  if (building) {
    std::ofstream file(argv[2],std::ios::binary);
    file.write(blob.data,blob.raw_size);
    file.close();
    std::cout << "WRITTEN_FILE_BYTES=" << blob.raw_size << "\n";
    delete[] blob.data;
    return 0;
  }
  std::cout << "SNAPSHOT_BYTES=" << blob.raw_size << "\n";
  {
    v8::Isolate::CreateParams params;
    params.array_buffer_allocator=allocator.get();
    params.snapshot_blob=&blob;
    params.external_references=references;
    v8::Isolate* isolate=v8::Isolate::New(params);
    {
      v8::Isolate::Scope is(isolate);
      v8::HandleScope hs(isolate);
      auto maybe=v8::Context::FromSnapshot(isolate,0,
        v8::DeserializeInternalFieldsCallback(RestoreWrapper,&fresh_graph));
      v8::Local<v8::Context> context;
      if(!maybe.ToLocal(&context)){std::cerr << "Context restoration failed\n";return 6;}
      v8::Context::Scope cs(context);
      if (wrong_origin) {
        // The host refuses to expose a partially restored context to any site
        // once a native resource is found to belong to the wrong origin.
        std::cout << "CROSS_ORIGIN_REBIND_REJECTED="
                  << (rejected_other_origin ? "true" : "false") << "\n";
        if (!rejected_other_origin) return 10;
      } else {
      if (rejected_other_origin) return 11;
      const auto result=Eval(isolate,context,"syntheticState()");
      std::cout << "BEFORE_NATIVE_EVENT_REBIND=" << result << "\n";
      std::cout << "SERIALIZATION_CALLBACKS=" << serialization_calls
                << " REBIND_CALLBACKS=" << rebinding_calls << "\n";
      if(result!="{\"counter\":41,\"nativeDocumentVersion\":99,\"nativeElementVersion\":66,\"nativeEventListenerCount\":0,\"documentReferenceStillSame\":true,\"elementReferenceStillSame\":true}") return 7;
      const auto rehydrated=Eval(isolate,context,"rebindSyntheticListeners()");
      if(rehydrated!="4") return 12;
      const auto after=Eval(isolate,context,"JSON.stringify({documentEvents:document.read(true),elementEvents:element.read(true),documentDispatch:document.dispatchSyntheticEvent(),elementDispatch:element.dispatchSyntheticEvent(),closureAfterDispatch:syntheticState()&&syntheticRegistrations[0].callback()})");
      std::cout << "AFTER_NATIVE_EVENT_REBIND=" << after << "\n";
      if(after!="{\"documentEvents\":3,\"elementEvents\":1,\"documentDispatch\":3,\"elementDispatch\":1,\"closureAfterDispatch\":47}") return 13;
      // Global handles must be released while the destination Isolate lives.
      fresh_document.callbacks.clear();
      fresh_element.callbacks.clear();
      }
    }
    isolate->Dispose();
  }
  if(!loading) delete[] blob.data;
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  std::cout << (wrong_origin ? "CROSS_ORIGIN_SNAPSHOT=DISCARDED" : "NATIVE_WRAPPER_REBIND=SUCCESS") << "\n";
  return 0;
}
