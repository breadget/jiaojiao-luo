package animalinterface;

/**
 * (2) 模拟器：playSound(Animal animal) 的参数是 Animal 类型，
 * 通过多态调用具体动物重写的 cry() 与 getAnimalName()。
 */
public class Simulator {
    public void playSound(Animal animal) {
        System.out.print("现在播放" + animal.getAnimalName() + "的声音：");
        animal.cry();
    }
}
