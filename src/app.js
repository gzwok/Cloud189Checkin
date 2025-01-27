/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
    },
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } },
});

const logger = log4js.getLogger();
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const accounts = require("../accounts");
const { sendNotify } = require("./sendNotify");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const doTask = async (cloudClient) => {
  const result = [];
  const res1 = await cloudClient.userSign();
  result.push(
    `${res1.isSign ? "个人空间已签到，" : ""}签到获得${res1.netdiskBonus}M空间`
  );
  await delay(5000);
  return result;
};

const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  let totalFamilyBonus = 0;
  const result = [];

  if (familyInfoResp) {
    const res = await cloudClient.familyUserSign(108508161137369);
    result.push(
      "家庭任务" +
        `${res.signStatus ? "已经签到过了，" : ""}签到获得${res.bonusSpace}M空间`
    );
    totalFamilyBonus += res.bonusSpace;
  }

  return { result, totalFamilyBonus };
};

const push = (title, desp) => {
  sendNotify(title, desp);
};

// 开始执行程序
async function main() {
  let totalFamilySpace = 0;

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const number = index + 1;
    const { userName, password } = account;

    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`${number}. 账户 ${userNameInfo} 开始执行`);
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();
        const taskResult = await doTask(cloudClient);
        taskResult.forEach((r) => logger.log(r));

        const { result: familyResult, totalFamilyBonus } = await doFamilyTask(cloudClient);
        familyResult.forEach((r) => logger.log(r));
        totalFamilySpace += totalFamilyBonus;

        const { cloudCapacityInfo, familyCapacityInfo } =
          await cloudClient.getUserSizeInfo();
        logger.log(
          `个人总容量：${(
            cloudCapacityInfo.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2)}G, 家庭总容量：${(
            familyCapacityInfo.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2)}G`
        );
      } catch (e) {
        logger.error(e);
        if (e.code === "ETIMEDOUT") {
          throw e;
        }
      } finally {
        logger.log(`账户 ${userNameInfo} 执行完毕-------------`);
      }
    }
  }

  logger.log(`GQQ主账号今天共获得家庭空间：${totalFamilySpace}M`);
  return totalFamilySpace;
}

(async () => {
  try {
    const totalFamilySpace = await main();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    const summary = `GQQ主账号今天共获得家庭空间：${totalFamilySpace}M`;
    push("GQQ天翼云盘签到任务", `${content}\n\n${summary}`);
    recording.erase();
  } catch (error) {
    logger.error("任务执行失败", error);
  }
})();
