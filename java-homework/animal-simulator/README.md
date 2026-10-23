# 动物声音模拟器（Java 作业）

题目要求：
1. 编写 `Animal` 接口，含抽象方法 `cry()` 和 `getAnimalName()`
2. 编写模拟器 `Simulator`，含 `playSound(Animal animal)` 方法
3. 编写实现 `Animal` 的 `Dog` 类和 `Cat` 类
4. 把接口 `Animal` 改成抽象类，重新实现上述功能

## 目录结构

```
animal-simulator/
├── interface-version/          接口版（第 1~3 问）
│   └── src/animalinterface/
│       ├── Animal.java         interface Animal
│       ├── Dog.java            implements Animal
│       ├── Cat.java            implements Animal
│       ├── Simulator.java      playSound(Animal animal)
│       └── Main.java           测试入口，含 main 方法
└── abstract-version/           抽象类版（第 4 问）
    └── src/animalabstract/
        ├── Animal.java         abstract class Animal
        ├── Dog.java            extends Animal
        ├── Cat.java            extends Animal
        ├── Simulator.java      playSound(Animal animal)
        └── Main.java           测试入口，含 main 方法
```

## 在 IntelliJ IDEA 里运行

**推荐做法：一个版本单独作为一个项目打开**

1. `File` → `Open`，选择 `interface-version`（或 `abstract-version`）这个**文件夹**，不要选上层的大项目目录
2. 若 IDEA 提示 trust project，选择信任
3. `File` → `Project Structure` → `Project`，把 SDK 设为 17 或更高（本机已有 JDK 21）
4. 在左侧展开 `src`，确保它有蓝色方块标记（Sources Root）。若没有：
   右键 `src` → `Mark Directory as` → `Sources Root`
5. 打开 `Main.java`，点左侧行号旁的绿色三角，选 `Run 'Main.main()'`

**两个版本必须分开作为独立项目打开。** 它们里面有同名的 `Animal`/`Dog`/`Cat`/`Simulator`/`Main`，
如果塞进同一个模块，IDEA 会报重复类错误、无法运行。

## 用命令行运行

```bash
cd interface-version/src
javac -encoding UTF-8 animalinterface/*.java
java animalinterface.Main
```

```bash
cd abstract-version/src
javac -encoding UTF-8 animalabstract/*.java
java animalabstract.Main
```

## 预期输出

```
现在播放狗的声音：汪汪汪！
现在播放猫的声音：喵喵喵！
```

## 核心考点

- `Simulator.playSound(Animal animal)` 的参数是**父类型**，实参是 `Dog`/`Cat` 对象时会向上转型
- 运行时按对象的实际类型决定调用哪个 `cry()`，这就是**多态（动态绑定）**
- 接口 → 抽象类的改动：`implements` 换成 `extends`，子类仍需重写全部抽象方法；
  抽象类还能拥有字段和已实现的方法（如 `sound`、`show()`），接口在 Java 8 之前不能
