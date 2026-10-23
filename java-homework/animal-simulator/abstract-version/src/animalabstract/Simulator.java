package animalabstract;

/**
 * (4) 模拟器：参数类型改为抽象类 Animal，功能不变。
 * 向上转型后调用重写方法，运行时仍然执行子类版本（动态绑定）。
 */
public class Simulator {
    public void playSound(Animal animal) {
        System.out.print("现在播放" + animal.getAnimalName() + "的声音：");
        animal.cry();
    }
}
