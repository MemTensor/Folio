#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/fcntl.h>
#include <mach/machine.h>
#include <libproc.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
#include <time.h>
#include <fts.h>

static NSString *HexDigest(unsigned char *digest) {
  char hex[65];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = 0; return @(hex);
}
static NSString *FileDigest(NSString *file) {
  int fd = open(file.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return nil;
  struct stat before, after;
  if (fstat(fd, &before) || !S_ISREG(before.st_mode)) { close(fd); return nil; }
  CC_SHA256_CTX context; CC_SHA256_Init(&context);
  unsigned char buffer[131072], digest[CC_SHA256_DIGEST_LENGTH]; ssize_t length;
  while ((length = read(fd, buffer, sizeof(buffer))) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)length);
  BOOL valid = length == 0 && fstat(fd, &after) == 0 && before.st_size == after.st_size &&
    before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
    before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
  close(fd); if (!valid) return nil;
  CC_SHA256_Final(digest, &context); return HexDigest(digest);
}

static double Clock(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return now.tv_sec + now.tv_nsec / 1e9;
}
static BOOL Matches(NSString *value, NSString *pattern) {
  return [value isKindOfClass:NSString.class] &&
    [value rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
}
static BOOL PlainDirectory(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  char resolved[PATH_MAX];
  struct stat info;
  return realpath(value.fileSystemRepresentation, resolved) &&
    [value isEqualToString:@(resolved)] && lstat(resolved, &info) == 0 && S_ISDIR(info.st_mode);
}
static NSDictionary *ReadJSON(NSString *file) {
  struct stat info;
  if (lstat(file.fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_uid != getuid() || (info.st_mode & 0022) || info.st_size > 65536) return nil;
  NSData *data = [NSData dataWithContentsOfFile:file];
  id result = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [result isKindOfClass:NSDictionary.class] ? result : nil;
}
static BOOL WriteJSON(NSString *file, NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  return data && [data writeToFile:file options:NSDataWritingAtomic error:nil];
}
static BOOL Receipt(NSDictionary *plan, NSString *status, NSString *code, BOOL backup) {
  return WriteJSON([plan[@"transactionDir"] stringByAppendingPathComponent:@"receipt.json"], @{
    @"nonce": plan[@"nonce"], @"status": status, @"code": code,
    @"version": plan[@"version"], @"previousVersion": plan[@"previousVersion"],
    @"requestId": plan[@"requestId"], @"backupAvailable": @(backup)
  });
}
static BOOL SameIdentity(struct stat info, NSDictionary *identity) {
  return [identity isKindOfClass:NSDictionary.class] &&
    Matches(identity[@"dev"], @"^[0-9]+$") && Matches(identity[@"ino"], @"^[0-9]+$") &&
    (uint64_t)info.st_dev == strtoull([identity[@"dev"] UTF8String], NULL, 10) &&
    (uint64_t)info.st_ino == strtoull([identity[@"ino"] UTF8String], NULL, 10);
}
static BOOL VerifySignature(NSString *bundle, id team) {
  if (!team || team == NSNull.null) return YES;
  if (!Matches(team, @"^[A-Z0-9]{10}$")) return NO;
  SecStaticCodeRef code = NULL;
  OSStatus result = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:bundle], kSecCSDefaultFlags, &code);
  if (result != errSecSuccess) return NO;
  result = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, NULL);
  CFDictionaryRef information = NULL;
  BOOL valid = result == errSecSuccess && SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) == errSecSuccess;
  if (valid) valid = [((__bridge NSDictionary *)information)[(__bridge id)kSecCodeInfoTeamIdentifier] isEqual:team];
  if (information) CFRelease(information);
  CFRelease(code);
  return valid;
}
static BOOL VerifyManifest(NSDictionary *plan) {
  NSString *file = plan[@"manifestPath"], *root = plan[@"stagePath"];
  if (![file isKindOfClass:NSString.class] ||
      ![file isEqual:[plan[@"transactionDir"] stringByAppendingPathComponent:@"manifest.json"]] ||
      !Matches(plan[@"manifestSHA256"], @"^[a-f0-9]{64}$")) return NO;
  struct stat fileInfo;
  if (lstat(file.fileSystemRepresentation, &fileInfo) || !S_ISREG(fileInfo.st_mode) || fileInfo.st_uid != getuid() ||
      (fileInfo.st_mode & 0022) || fileInfo.st_size > 16 * 1024 * 1024) return NO;
  NSData *data = [NSData dataWithContentsOfFile:file]; if (!data) return NO;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  if (![HexDigest(digest) isEqual:plan[@"manifestSHA256"]]) return NO;
  NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![manifest isKindOfClass:NSDictionary.class] || ![manifest[@"version"] isEqual:@1] ||
      ![manifest[@"entries"] isKindOfClass:NSArray.class] || [manifest[@"entries"] count] > 20000) return NO;
  NSMutableDictionary *expected = [NSMutableDictionary dictionary];
  for (NSDictionary *entry in manifest[@"entries"]) {
    if (![entry isKindOfClass:NSDictionary.class] || ![entry[@"path"] isKindOfClass:NSString.class] ||
        ![entry[@"mode"] isKindOfClass:NSNumber.class] || expected[entry[@"path"]]) return NO;
    expected[entry[@"path"]] = entry;
  }
  char *base = strdup(root.fileSystemRepresentation), *paths[] = {base, NULL};
  FTS *walk = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR, NULL);
  if (!walk) { free(base); return NO; }
  BOOL valid = YES; NSUInteger count = 0;
  FTSENT *node;
  while ((node = fts_read(walk))) {
    if (node->fts_info == FTS_DP) continue;
    if (++count > 20000 || !node->fts_statp) { valid = NO; break; }
    NSString *absolute = @(node->fts_path);
    NSString *relative = [absolute isEqual:root] ? @"" : [absolute substringFromIndex:root.length + 1];
    NSDictionary *entry = expected[relative];
    if (!entry || ([entry[@"mode"] unsignedIntValue] != (node->fts_statp->st_mode & 0777))) { valid = NO; break; }
    if (node->fts_info == FTS_D) valid = [entry[@"type"] isEqual:@"directory"];
    else if (node->fts_info == FTS_F) {
      valid = [entry[@"type"] isEqual:@"file"] && [entry[@"size"] isKindOfClass:NSNumber.class] &&
        [entry[@"size"] unsignedLongLongValue] == (uint64_t)node->fts_statp->st_size &&
        Matches(entry[@"sha256"], @"^[a-f0-9]{64}$") && [FileDigest(absolute) isEqual:entry[@"sha256"]];
    } else if (node->fts_info == FTS_SL || node->fts_info == FTS_SLNONE) {
      NSString *link = [[NSFileManager defaultManager] destinationOfSymbolicLinkAtPath:absolute error:nil];
      valid = [entry[@"type"] isEqual:@"symlink"] && [link isEqual:entry[@"target"]];
    } else valid = NO;
    if (!valid) break;
  }
  if (count != expected.count) valid = NO;
  fts_close(walk); free(base); return valid;
}
static BOOL ValidBundle(NSString *bundle, NSString *version, NSString *arch, id team) {
  if (!PlainDirectory(bundle)) return NO;
  for (NSString *part in @[@"Contents", @"Contents/MacOS", @"Contents/Resources", @"Contents/Resources/cli"])
    if (!PlainDirectory([bundle stringByAppendingPathComponent:part])) return NO;
  for (NSString *part in @[@"Contents/Info.plist", @"Contents/MacOS/Folio", @"Contents/Resources/app.asar", @"Contents/Resources/cli/folio.cjs"]) {
    struct stat info;
    if (lstat([bundle stringByAppendingPathComponent:part].fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size == 0) return NO;
  }
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[bundle stringByAppendingPathComponent:@"Contents/Info.plist"]];
  if (![info[@"CFBundleIdentifier"] isEqual:@"io.folio.markdown"] ||
      ![info[@"CFBundleExecutable"] isEqual:@"Folio"] ||
      ![info[@"CFBundleShortVersionString"] isEqual:version] ||
      ![info[@"CFBundleVersion"] isEqual:version]) return NO;
  NSArray *architectures = [[NSBundle bundleWithPath:bundle] executableArchitectures];
  NSNumber *expected = [arch isEqual:@"arm64"] ? @(CPU_TYPE_ARM64) : @(CPU_TYPE_X86_64);
  return [architectures containsObject:expected] && VerifySignature(bundle, team);
}
static BOOL ValidPlan(NSDictionary *plan, NSString *file) {
  if (!plan) return NO;
  for (NSString *key in @[@"targetPath", @"stagePath", @"transactionDir", @"dataDir", @"planPath", @"version", @"previousVersion", @"arch", @"nonce", @"id", @"requestId"])
    if (![plan[key] isKindOfClass:NSString.class]) return NO;
  if (![[NSUUID alloc] initWithUUIDString:plan[@"id"]] || ![[NSUUID alloc] initWithUUIDString:plan[@"requestId"]] ||
      !Matches(plan[@"nonce"], @"^[a-f0-9]{64}$") ||
      ![plan[@"bundleId"] isEqual:@"io.folio.markdown"] ||
      ![@[@"arm64", @"x64"] containsObject:plan[@"arch"]] ||
      ![plan[@"parentPid"] isKindOfClass:NSNumber.class] || [plan[@"parentPid"] intValue] <= 1) return NO;
  NSString *target = plan[@"targetPath"], *stage = plan[@"stagePath"], *transaction = plan[@"transactionDir"];
  if (![file isEqual:plan[@"planPath"]] || ![[file stringByDeletingLastPathComponent] isEqual:transaction] ||
      !PlainDirectory(plan[@"dataDir"]) || ![[transaction stringByDeletingLastPathComponent] isEqual:[plan[@"dataDir"] stringByAppendingPathComponent:@"updates"]] ||
      !PlainDirectory(transaction) || ![transaction.lastPathComponent hasPrefix:@"install-"] ||
      ![[target stringByDeletingLastPathComponent] isEqual:[stage stringByDeletingLastPathComponent]] ||
      ![target hasSuffix:@".app"] || [target containsString:@"/AppTranslocation/"] || [target hasPrefix:@"/Volumes/"] ||
      ![stage.lastPathComponent isEqual:[NSString stringWithFormat:@".folio-update-%@.app", plan[@"id"]]]) return NO;
  struct stat targetInfo, stageInfo, transactionInfo;
  if (lstat(transaction.fileSystemRepresentation, &transactionInfo) || !SameIdentity(transactionInfo, plan[@"transactionIdentity"]) ||
      lstat(target.fileSystemRepresentation, &targetInfo) || lstat(stage.fileSystemRepresentation, &stageInfo) ||
      !SameIdentity(targetInfo, plan[@"targetIdentity"]) || !SameIdentity(stageInfo, plan[@"stageIdentity"]) ||
      targetInfo.st_dev != stageInfo.st_dev || !S_ISDIR(targetInfo.st_mode) || !S_ISDIR(stageInfo.st_mode)) return NO;
  return ValidBundle(target, plan[@"previousVersion"], plan[@"arch"], plan[@"targetIdentity"][@"teamIdentifier"]) &&
    ValidBundle(stage, plan[@"version"], plan[@"arch"], plan[@"expectedTeam"]) && VerifyManifest(plan);
}
static BOOL SwapBundles(NSDictionary *plan, BOOL rollback) {
  NSString *parent = [plan[@"targetPath"] stringByDeletingLastPathComponent];
  if (!PlainDirectory(parent)) return NO;
  int fd = open(parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (fd < 0) return NO;
  const char *target = [plan[@"targetPath"] lastPathComponent].fileSystemRepresentation;
  const char *stage = [plan[@"stagePath"] lastPathComponent].fileSystemRepresentation;
  struct stat oldInfo, newInfo;
  BOOL valid = fstatat(fd, target, &oldInfo, AT_SYMLINK_NOFOLLOW) == 0 && fstatat(fd, stage, &newInfo, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(oldInfo.st_mode) && S_ISDIR(newInfo.st_mode) &&
    SameIdentity(oldInfo, plan[rollback ? @"stageIdentity" : @"targetIdentity"]) &&
    SameIdentity(newInfo, plan[rollback ? @"targetIdentity" : @"stageIdentity"]);
  BOOL swapped = valid && renameatx_np(fd, target, fd, stage, RENAME_SWAP) == 0;
  if (swapped) (void)fsync(fd);
  close(fd); return swapped;
}
static BOOL Canceled(NSDictionary *plan) {
  NSString *file = [plan[@"transactionDir"] stringByAppendingPathComponent:@"cancel.json"];
  return [[NSFileManager defaultManager] fileExistsAtPath:file];
}
static BOOL Acknowledged(NSDictionary *plan) {
  NSDictionary *ack = ReadJSON([plan[@"transactionDir"] stringByAppendingPathComponent:@"ack.json"]);
  return [ack[@"nonce"] isEqual:plan[@"nonce"]] && [ack[@"version"] isEqual:plan[@"version"]];
}
static BOOL Alive(pid_t pid) { return pid > 1 && (kill(pid, 0) == 0 || errno == EPERM); }
static BOOL BundleRunning(NSString *bundle) {
  int count = proc_listallpids(NULL, 0);
  if (count <= 0 || count > 65536) return YES;
  int capacity = count + 256;
  pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
  if (!pids) return YES;
  count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
  BOOL running = NO;
  NSString *prefix = [bundle stringByAppendingString:@"/"];
  for (int i = 0; i < MIN(count, capacity); i++) {
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (pids[i] == getpid()) continue;
    if (proc_pidpath(pids[i], executable, sizeof(executable)) > 0 && [@(executable) hasPrefix:prefix]) { running = YES; break; }
  }
  free(pids); return running;
}
static BOOL PruneBackup(NSString *file) {
  NSDictionary *plan = ReadJSON(file);
  if (![plan[@"targetPath"] isKindOfClass:NSString.class] || ![plan[@"stagePath"] isKindOfClass:NSString.class] ||
      ![plan[@"transactionDir"] isKindOfClass:NSString.class] || ![[NSUUID alloc] initWithUUIDString:plan[@"id"]] ||
      ![[NSUUID alloc] initWithUUIDString:plan[@"requestId"]] || !Matches(plan[@"nonce"], @"^[a-f0-9]{64}$") ||
      ![plan[@"version"] isKindOfClass:NSString.class] || ![plan[@"previousVersion"] isKindOfClass:NSString.class] ||
      ![@[@"arm64", @"x64"] containsObject:plan[@"arch"]] || ![plan[@"bundleId"] isEqual:@"io.folio.markdown"]) return NO;
  NSString *target = plan[@"targetPath"], *stage = plan[@"stagePath"];
  if (![file isEqual:[plan[@"transactionDir"] stringByAppendingPathComponent:@"plan.json"]] ||
      !PlainDirectory(plan[@"transactionDir"]) || !PlainDirectory(target) || !PlainDirectory(stage) ||
      ![[target stringByDeletingLastPathComponent] isEqual:[stage stringByDeletingLastPathComponent]] ||
      ![stage.lastPathComponent isEqual:[NSString stringWithFormat:@".folio-update-%@.app", plan[@"id"]]]) return NO;
  NSDictionary *receipt = ReadJSON([plan[@"transactionDir"] stringByAppendingPathComponent:@"receipt.json"]);
  struct stat info;
  if (![receipt[@"nonce"] isEqual:plan[@"nonce"]] || ![receipt[@"status"] isEqual:@"confirmed"] ||
      lstat(stage.fileSystemRepresentation, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() ||
      !SameIdentity(info, plan[@"targetIdentity"]) || BundleRunning(stage) ||
      !ValidBundle(stage, plan[@"previousVersion"], plan[@"arch"], plan[@"targetIdentity"][@"teamIdentifier"])) return NO;
  if (lstat(stage.fileSystemRepresentation, &info) || !SameIdentity(info, plan[@"targetIdentity"])) return NO;
  if (![[NSFileManager defaultManager] removeItemAtPath:stage error:nil]) return NO;
  Receipt(plan, @"confirmed", @"CONFIRMED", NO); return YES;
}
static pid_t Launch(NSString *bundle, NSArray *arguments, NSString *dataDir) {
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  configuration.arguments = arguments; configuration.activates = YES;
  configuration.environment = @{@"FOLIO_DATA_DIR": dataDir, @"HOME": NSHomeDirectory(), @"USER": NSUserName(), @"LOGNAME": NSUserName(), @"PATH": @"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"};
  configuration.createsNewApplicationInstance = YES;
  NSObject *lock = [NSObject new];
  __block BOOL complete = NO;
  __block pid_t pid = 0;
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:bundle] configuration:configuration completionHandler:^(NSRunningApplication *app, NSError *error) {
    @synchronized(lock) { if (!error) pid = app.processIdentifier; complete = YES; }
  }];
  double deadline = Clock() + 30;
  while (Clock() < deadline) {
    @synchronized(lock) { if (complete) return pid; }
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  }
  return 0;
}
static void DiscardUninstalledStage(NSDictionary *plan) {
  struct stat info;
  NSString *stage = plan[@"stagePath"];
  if (lstat(stage.fileSystemRepresentation, &info) == 0 && S_ISDIR(info.st_mode) && SameIdentity(info, plan[@"stageIdentity"]))
    [[NSFileManager defaultManager] removeItemAtPath:stage error:nil];
}
static int Rollback(NSDictionary *plan, NSString *code) {
  // Never replace an application that could already be editing documents.
  if (BundleRunning(plan[@"targetPath"])) { Receipt(plan, @"awaiting-confirmation", @"APP_BUSY", YES); return 1; }
  if (!SwapBundles(plan, YES)) { Receipt(plan, @"failed", @"ROLLBACK_FAILED", YES); return 1; }
  Receipt(plan, @"rolled-back", code, NO);
  Launch(plan[@"targetPath"], @[@"--folio-update-rollback"], plan[@"dataDir"]);
  return 1;
}
static int RunUpdate(NSDictionary *plan) {
  if (!Receipt(plan, @"waiting-exit", @"WAITING_EXIT", NO)) return 1;
  puts("READY"); fflush(stdout);
  double deadline = Clock() + 120;
  pid_t parent = [plan[@"parentPid"] intValue];
  while (Alive(parent) || BundleRunning(plan[@"targetPath"])) {
    if (Canceled(plan)) { Receipt(plan, @"failed", @"CANCELED", NO); DiscardUninstalledStage(plan); return 1; }
    if (Clock() >= deadline) { Receipt(plan, @"failed", Alive(parent) ? @"PARENT_TIMEOUT" : @"APP_BUSY", NO); return 1; }
    usleep(100000);
  }
  if (Canceled(plan)) { Receipt(plan, @"failed", @"CANCELED", NO); DiscardUninstalledStage(plan); return 1; }
  if (!ValidPlan(plan, plan[@"planPath"])) { Receipt(plan, @"failed", @"BUNDLE_CHANGED", NO); return 1; }
  if (Canceled(plan)) { Receipt(plan, @"failed", @"CANCELED", NO); DiscardUninstalledStage(plan); return 1; }
  if (!SwapBundles(plan, NO)) { Receipt(plan, @"failed", @"SWAP_FAILED", NO); return 1; }
  if (!Receipt(plan, @"installed", @"WAITING_STARTUP", YES)) return Rollback(plan, @"INTERNAL_ERROR");
  pid_t newer = Launch(plan[@"targetPath"], @[@"--folio-update", plan[@"nonce"]], plan[@"dataDir"]);
  if (!newer) return Rollback(plan, @"LAUNCH_FAILED");
  deadline = Clock() + 60;
  while (Clock() < deadline) {
    if (Acknowledged(plan)) { Receipt(plan, @"confirmed", @"CONFIRMED", YES); return 0; }
    if (!Alive(newer)) return Rollback(plan, @"STARTUP_FAILED");
    usleep(100000);
  }
  if (!Alive(newer)) return Rollback(plan, @"STARTUP_FAILED");
  Receipt(plan, @"awaiting-confirmation", @"STARTUP_UNCONFIRMED", YES);
  return 0;
}

#ifndef FOLIO_UPDATE_HELPER_TESTING
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    umask(0077); signal(SIGPIPE, SIG_IGN);
    if (argc == 3 && strcmp(argv[1], "--prune") == 0) {
      BOOL pruned = PruneBackup(@(argv[2]));
      puts(pruned ? "{\"pruned\":true}" : "{\"pruned\":false}");
      return 0;
    }
    if (argc != 2) return 2;
    NSString *file = @(argv[1]);
    NSDictionary *plan = ReadJSON(file);
    if (!Matches(plan[@"helperSHA256"], @"^[a-f0-9]{64}$") || ![FileDigest(@(argv[0])) isEqual:plan[@"helperSHA256"]] || !ValidPlan(plan, file)) return 2;
    @try { return RunUpdate(plan); }
    @catch (NSException *error) { Receipt(plan, @"failed", @"INTERNAL_ERROR", YES); return 1; }
  }
}
#endif
