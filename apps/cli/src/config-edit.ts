// 配置编辑原语已迁至 @volund/app-runtime（P1-04c）；re-export 保持既有引用兼容。
export {
  assignConfigValue,
  assertConfigKeyValue,
  builtinDisabledFrom,
  deleteConfigValue,
  disabledNamesFrom,
  getConfigValue,
  readConfigFileOrEmpty,
  updateConfigBuiltinDisabled,
  updateConfigDisabledList,
  writeConfigFile,
} from '@volund/app-runtime'
